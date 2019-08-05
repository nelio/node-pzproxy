"use strict";

const Cache  = require('./cache');
const Proxy  = require('./proxy');
const Server = require('./server');

class ProxyCache{
	constructor(opts){
        if ( !opts )
            opts = {};
        this.opts = opts;

        // The default request handler
        if (!opts.onRequest) {
            opts.onRequest = (req, res, cb) => cb();
        }

        // The default request-finish handler
        if ( !opts.onFinish ) {
            opts.onFinish = (req,res,infos,cb) => cb();
        }

        // The default shouldCache function (decides whether to cache or not)
        if ( !opts.shouldCache ) {
            opts.shouldCache = (req,res,preq,pres) => true;
        }

        // The default logAccess function
        this.logAccess = opts.logAccess || ProxyCache._logAccess;

        // Debug ?
        this.debug = this.opts.debug;

        // Default request timeout
        this.defaultTimeout = opts.defaultTimeout || 60;

        // Do we have a cache instance ? Create the default one
        if ( !opts.cache )
            opts.cache = new Cache(opts.cacheOpts);

        // Do we have a proxy instance ? Create the default one
        if ( !opts.proxy ) {
            opts.proxy = new Proxy(Object.assign({}, opts.proxyOpts, {
                cache: opts.cache,
                shouldCache: opts.shouldCache
            }));
        }

        // Do we have a server instance ? Create the default one
        if ( !opts.server )
            opts.server = new Server(opts.serverOpts||{port:opts.port||8080});

        // Copy our 3 objects
        this.cache  = opts.cache;
        this.proxy  = opts.proxy;
        this.server = opts.server;

        // Listen for a request
        var self = this;
        self.server.on('request', (req,res) => {

            // The default cache key and TTL
            req.cacheKey = req.url;
            req.cacheTTL = self.opts.defaultTTL || 0;
            // Proxy and hold counters
            req.xProxyCount = 0;
            req.xProxyTime = 0;
            req.xHoldCount = 0;
            req.xHoldTime  = 0;

            // Useful methods
            // Just answer
            res.answer = (status,headers,data,flags) => {
                res.writeHead(status,headers);
                if (data) res.write(data);
                res.end();
                self._finishRequest(req, res, {docSize: data ? data.length : 0, flags: (flags || ['s'])});
            };

            // Call the request handler and make it flow
            return opts.onRequest(req, res, () => self.flowRequest(req, res));

        });


        // State data
        this.requestQueues = {};


    }

    // Handle a request (lookup on cache and proxy)
	flowRequest(req,res) {
        let self = this;

        self._debug(req,"Flowing to "+req.url+" ("+req.cacheKey+")");

        // Do we have a backendURL ? Build one!
        if ( !req.backendURL ) {
            if ( self.proxy.opts.target )
                req.backendURL = require('url').resolve(self.proxy.opts.target,req.url);
            else
                throw new Error("You haven't defined neither a req.backendURL nor a proxyOpts.target");
        }

        // Is it cached ?
        self._debug(req,"Checking cache for "+req.cacheKey);
        return self.cache.check(req.cacheKey,req.cacheTTL,(err,isCached) => {
            if ( err ) {
                self._debug(req,"Error checking if item '"+req.cacheKey+"' is in cache. Please fix it: ",err);
                return res.answer(500.1,{'content-type':'text/plain'},'500.1 - Cache check error');
            }

            if ( isCached ) {
                self._debug(req,"Seems that we have cache for "+req.cacheKey);

                // Serve it from cache
                return self.cache.get(req.cacheKey, (err,resLine,stream) => {
                    if ( err ) {
                        self._debug(req,"Item '"+req.cacheKey+"' is cached but got an error while trying to get it: ",err);
                        return res.answer(500.2,{'content-type':'text/plain'},'500.2 - Cache retrieve error');
                    }
                    self._debug(req,"Got cache item on ",req.url);

                    // Send the cached data
                    resLine.headers['X-Cached'] = 'HIT';
                    res.writeHead(resLine.statusCode,resLine.headers);
                    var docSize = 0;
                    stream.on('data',(d) =>{
                        docSize += d.length;
                    });
                    stream.on('end',() => {
                        self._finishRequest(req,res,{docSize: docSize,flags:['C']});
                    });
                    stream.on('error',(err) => {
                        console.log("Error while reading the cache stream (1) for the cache key '"+req.cacheKey+"': ",err);
                        res.end();
                        stream.end();
                    });
                    stream.pipe(res);
                });
            }

            // Not cached
            self._debug(req,"We have NO cache for "+req.cacheKey+". Probably proxying "+req.url+" to "+req.backendURL);

            // If we have a cache key and a cache TTL higher than zero, we want to queue similar requests
            if ( req.cacheKey && req.cacheTTL > 0 ) {

                // Register the request and check if it got queued, otherwise.. just proxy it!
                if ( !self._queueRequest(req,res) )
                    return self._proxyNext(req.cacheKey);

            }
            else {

                // No cache key or cacheTTL is zero, just proxy everything!
                return self._proxyRequest(req, res, (err, infos) => {
                    self._finishRequest(req, res, infos);
                });

            }

        });
    }

    // Proxy the next request on the list of waiting requests and serve the other ones
    _proxyNext(cacheKey) {
        let self = this;
        let next = self.requestQueues[cacheKey].shift();
        let req = next.req;
        let res = next.res;

        // Check if we are counting the time on hold for this request
        if (next.start != null)
            req.xHoldTime += new Date() - next.start;

        self._debug(req, "Performing proxy request to " + req.backendURL + " (" + req.cacheKey + ")");
        return self._proxyRequest(req, res, (err, infos) => {

            // Finish the request
            self._finishRequest(req, res, infos);

            // Do we have other queued requests for the same cache key?
            if (self.requestQueues[cacheKey]) {

                // The key is there but the queue is empty, make sure we delete it
                if (self.requestQueues[cacheKey].length == 0)
                    delete self.requestQueues[cacheKey];

                // Serve all the other requests from cache
                else {
                    self._serveWaitingRequests(req.cacheKey, req.cacheTTL);
                }

            }
        });

    }

    // Register a request and returns true/false depending whether the request was queued or not
    _queueRequest(req, res) {

        let self = this;

        // Check if we have a pending request for the same cacheKey, and if we do.. hold it
        if (self.requestQueues[req.cacheKey]) {
            self._debug(req, "Queing request to " + req.url + ". Got number #" + self.requestQueues[req.cacheKey].length);
            req.xHoldCount++;
            self.requestQueues[req.cacheKey].push({req: req, res: res, start: new Date()});
            return true;
        }

        self.requestQueues[req.cacheKey] = [{req: req, res: res}];
        return false;

    }

    // Proxy a request
    _proxyRequest(req, res, callback) {

        let self = this;
        let startTime = new Date();

        // Count that proxy request
        req.xProxyCount++;

        // Proxy the request
        return self.proxy.proxyRequest(req, res, req.backendURL, {
            cache: self.cache,
            cacheKey: req.cacheKey,
            timeout: self.defaultTimeout
        }, (err, req, res, preq, pres, infos) => {

            // Add the time spent on that request
            req.xProxyTime += new Date() - startTime;

            // Return
            return callback(err, infos);
        });


    }


    // Serve waiting requests for a specific cache key
    _serveWaitingRequests(cacheKey,cacheTTL) {

        let self = this;
        let waitingQueue;
        let now;

        // Is it cached ?
        return self.cache.check(cacheKey,cacheTTL,(err,isCached) => {
            if ( err ) {
                console.log("WARN: Error checking if item '"+cacheKey+"' is in cache. Please fix it: ",err);
                return self._proxyNext(cacheKey);
            }

            if ( !isCached ) {
                console.log("WARN: After caching the response, it is not in cache - maybe it has expired");
                return self._proxyNext(cacheKey);
            }

            // Serve it from cache
            return self.cache.get(cacheKey,(err,resLine,stream) => {
                if ( err ) {
                    console.log("ERROR: Error getting item '"+cacheKey+"' from cache after confirming that it was there. Please fix it: ",err);
                    return self._proxyNext(cacheKey);
                }

                // Get the waiting request queue
                waitingQueue = self.requestQueues[cacheKey].slice(0);

                // Remove the waiting customers from the list
                delete self.requestQueues[cacheKey];

                // Add the time that each request was on queue
                now = new Date();
                waitingQueue.forEach((customer) => {
                    if (customer.start)
                        customer.req.xHoldTime += now - customer.start;
                });

                // Send the cached data
                waitingQueue.forEach((customer) => {
                    resLine.headers['X-Cached'] = 'HIT';
                    customer.res.writeHead(resLine.statusCode, resLine.headers);
                });
                var docSize = 0;
                stream.on('data', (d) => {
                    docSize += d.length;
                    waitingQueue.forEach((customer) => {
                        customer.res.write(d);
                    });
                });

                // Finish the responses/requests
                stream.on('end', () => {
                    waitingQueue.forEach((customer) => {
                        customer.res.end();
                        return self._finishRequest(customer.req, customer.res, {docSize: docSize, flags: ['Q', 'C']});
                    });
                });

                // Error while reading the cache file
                stream.on('error',(err) => {
                    console.log("Error while reading the cache stream (2) for the cache key '"+req.cacheKey+"': ",err);
                    stream.end();
                });
            });


        });

    }

    // Finish a request
	_finishRequest(req,res,infos) {

        let self = this;

        // Mark the request as finished (avoids finishing the same request twice - can happen by using res.answer() internally)
        if ( req._finished )
            return;
        req._finished = true;

        self._debug(req,"Finishing request "+req.xRequestID);
        return ProxyCache._if ( self.opts.onFinish,
            (next) => {
                self.opts.onFinish(req,res,infos,next);
            },
            () => {
                self.logAccess(req,res,infos.docSize||'??',infos.flags||[])
            }
        );

    }

    // The magic if
    static _if(cond, a, b) {
        return cond ? a(b) : b();
    }

    // Debug
    _debug(req,...args) {
        args.unshift(req.xRequestID);
        console.log.apply(null,args);
    }

    // Log
    static _logAccess(req,res,length,flags) {

        const timeSpent = new Date().getTime() - req.xConnectDate.getTime();

        if ( !flags )
            flags = [];

        console.log(req.xRemoteAddr+(req.xDirectRemoteAddr?"/"+req.xDirectRemoteAddr:"")+" - "+req.xRequestID+" ["+req.xConnectDate.toString()+"] \""+req.method+" "+(req.originalURL || req.url)+" HTTP/"+req.httpVersionMajor+"."+req.httpVersionMajor+"\" "+res.statusCode+" "+(length||"-")+" "+(timeSpent / 1000).toString()+" "+(flags.join('')||""));

    };


}

// Export myself
module.exports = ProxyCache;
