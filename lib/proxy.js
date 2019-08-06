const http   = require('http');
const https  = require('https');
const debug = require('debug')('proxy.js');

// A proxy instance
class Proxy {
    constructor(opts = {}){
        this.opts = opts;

        if ( opts.target ) {
            if ( !opts.target.match(/^https?:\/\//) ) {
                opts.target = 'http://'+opts.target;
            }
            opts.target = require('url').parse(opts.target);
        }

        this.outputFilter = opts.outputFilter;
    }

    // Proxy a request
    proxyRequest(req, res, target, opts = {}, callback = () => {}) {
        const self = this;

        let targetIsURL = true;
        let timeout = null;
        let fired = false;
        let docSize = 0;
        let request = {};

        const _canHandleRequest = () => {
            if (fired) {
                return false;
            }
            fired = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            return true;
        };

        // Validate target
        if (!target) {
            throw new Error('No host/url to send the request');
        }

        // Parse target
        if ( typeof target != 'object' ) {
            if ( target.match(/^[^/]+(?::(\d+))?$/) ) {
                target = 'http://'+target+'/';
                targetIsURL = false;
            }
            target = require('url').parse(target);
        }

        request = {
            ...target,
            ...opts,
            path: targetIsURL ? target.path : req.url,
            headers: req.headers || {},
            method: req.method
        };

        // Delete some useless stuff
        ['cache', 'cacheKey', 'keepHost', 'timeout', 'onTimeout', 'onError'].forEach((prop) => {
            delete request[prop];
        });

        // Should we keep the original host header ?
        if ( !opts.keepHost ) {
            request.headers.host = target.host;
        }

        // Perform the request
        Proxy._debug('Performing request: ',JSON.stringify(request));
        const proto = (request.protocol === 'https:') ? https : http;
        const preq = proto.request(request);

        // Timeout event
        if ( opts.timeout ) {
            timeout = setTimeout(()=>{
                if ( !_canHandleRequest() ) {
                    return;
                }
                preq.abort();
                if ( opts.onTimeout ) {
                    return opts.onTimeout();
                }
                res.answer(504,{'Content-type':'text/plain; charset=UTF-8'},'504 - Gateway timeout :-(',['P','a','T']);
                return callback ? callback(null,req,res,preq,null,{}) : null;
            },opts.timeout*1000);
        }

        // Should we abort on client disconnect ? We can still wait for the answer and store it in cache
        if ( self.opts.abortOnClientDisconnect ) {
            req.on('close',()=>{
                if ( !_canHandleRequest() ) {
                    return;
                }
                preq.abort();
                return callback ? callback(null,req,res,preq,null,{docSize: null, flags: ['P','a','d']}) : null;
            });
        }

        // On response arrive
        preq.on('response',(pres) =>{
            if ( !_canHandleRequest() ) {
                return;
            }
            req.xProxyGotRespHeaders = new Date();

            // Write the head
            pres.headers['X-Cached'] = 'MISS';
            res.writeHead(pres.statusCode,pres.headers);

            // If we have to filter the output, gather all the data, filter it and send it
            if ( typeof self.outputFilter == 'function' && ["GET","POST"].includes(req.method)) {
                let allData = null;
                pres.on('data',(data) => {
                    let newB = Buffer.alloc(((allData != null) ? allData.length : 0) + data.length);
                    if ( allData != null ) {
                        allData.copy(newB,0,0,allData.length);
                    }
                    data.copy(newB,(allData != null)?allData.length:0,0,data.length);
                    allData = newB;
                });
                pres.on('end',() => {
                    debug(`Invoking output filter`);
                    self.outputFilter(allData,req,res,preq,pres).then((d) => {
                        if ( d === null ) {
                            d = allData || Buffer.from('');
                        }
                        docSize = d.length;
                        debug({...pres.headers,'content-length': docSize.toString()});
                        res.writeHead(pres.statusCode, {...pres.headers,'content-length': docSize.toString()});
                        // Write the data and finish it
                        res.write(d);
                        res.end();

                        // Run the callback
                        return callback ? callback(null,req,res,preq,pres,{docSize: docSize, flags: ['P','F']}) : null;

                    });
                });
            }
            else {

                // Just pipe it to the user!
                pres.pipe(res);
                docSize = 0;
                pres.on('data',(chunk) => {
                    docSize += chunk.length;
                });
                pres.on('end',() => {
                    res.end();
                    // Run the callback
                    return callback ? callback(null,req,res,preq,pres,{docSize: docSize, flags: ['P']}) : null;
                });

            }
        });
        preq.on('error',(e) => {
            if ( opts.onError ) {
                return opts.onError(e);
            }
            if ( !_canHandleRequest() ) {
                return;
            }
            preq.abort();

            let msg = '503 - Gateway error: '+e.toString();
            res.answer(503,{'content-type':'text/plain; charset=UTF-8'},msg,['P','a','E']);
            Proxy._debug(req,'Error performing HTTP request: ',e.toString());
            return callback ? callback(null,req,res,preq,null,{}) : null;
        });
        if ( req.headers && req.headers['content-length'] ) {
            req.pipe(preq);
        } else {
            preq.end();
        }

    }

    static _debug(req) {
        const args = Array.prototype.slice.call(arguments, 0);

        args.unshift(req.xRequestID);
        debug.apply(null,args);

    }
}

// Export myself
module.exports = Proxy;
