var
    Cache  = require('./cache'),
    Proxy  = require('./proxy'),
    Server = require('./server');


function ProxyCache(opts) {

	if ( !opts )
		opts = {};
	this.opts = opts;

	// The default request handler
	if ( !opts.onRequest ) {
		opts.onRequest = function(req,res,cb){
			return cb();
		};
	}

	// The default request-finish handler
	if ( !opts.onFinish ) {
		opts.onFinish = function(req,res,infos,cb){
			return cb();
		};
	}

	// Do we have a cache instance ? Create the default one
	if ( !opts.cache )
		opts.cache = new Cache(opts.cacheOpts);

	// Do we have a proxy instance ? Create the default one
	if ( !opts.proxy )
		opts.proxy = new Proxy(_merge(opts.proxyOpts||{},{cache: opts.cache}));

	// Do we have a server instance ? Create the default one
	if ( !opts.server )
		opts.server = new Server(opts.serverOpts||{port:opts.port||8080});

	// Copy our 3 objects
	this.cache  = opts.cache;
	this.proxy  = opts.proxy;
	this.server = opts.server;

	// Listen for a request
	var self = this;
	self.server.on('request',function(req,res){

		// The default cache key and TTL
		req.cacheKey = req.url;
		req.cacheTTL = self.opts.defaultTTL || 0;

		// Useful methods
		// Just answer
		res.answer = function(status,headers,data){
			res.writeHead(status,headers);
			res.write(data);
			res.end();
			self._finishRequest(req,res,{docSize:data.length,flags:['s']});
		};

		// Call the request handler and make it flow
		return opts.onRequest(req,res,function(){ self.flowRequest(req,res); });

	});


	// State data
	this.requestQueues = {};

	// Self methods
	this.flowRequest			= _flowRequest;
	this._serveWaitingRequests	= _serveWaitingRequests;
	this._proxyNext				= _proxyNext;
	this._finishRequest			= _finishRequest;
	this._debug					= _debug;

}

// Handle a request (lookup on cache and proxy)
function _flowRequest(req,res) {

	var
		self = this;

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
	return self.cache.check(req.cacheKey,req.cacheTTL,function(err,isCached){
		if ( err ) {
			self._debug(req,"Error checking if item '"+req.cacheKey+"' is in cache. Please fix it: ",err);
			return res.answer(500.1,{'content-type':'text/plain'},'500.1 - Cache check error');
		}

		if ( isCached ) {
			self._debug(req,"Seems that we have cache for "+req.cacheKey);

			// Serve it from cache
			return self.cache.get(req.cacheKey,function(err,resLine,stream){
				if ( err ) {
					self._debug(req,"Item '"+req.cacheKey+"' is cached but got an error while trying to get it: ",err);
					return res.answer(500.2,{'content-type':'text/plain'},'500.2 - Cache retrieve error');
				}
				self._debug(req,"Got cache item on ",req.url);

				// Send the cached data
				resLine.headers['x-cache'] = 'HIT';
				res.writeHead(resLine.statusCode,resLine.headers);
				var docSize = 0;
				stream.on('data',function(d){
					docSize += d.length;
				});
				stream.on('end',function(){
					self._finishRequest(req,res,{docSize: docSize||'??',flags:['C']});
				});
				stream.pipe(res);
			});

		}

		// Not cached
		self._debug(req,"We have NO cache for "+req.cacheKey+". Probably proxying "+req.url+" to "+req.backendURL);

		// If we have a cache key and a cache TTL higher than zero, we want to queue similar requests
		if ( req.cacheKey && req.cacheTTL > 0 ) {

			// Check if we have a pending request for the same cacheKey, and if we do.. hold it
			if ( self.requestQueues[req.cacheKey] ) {
				self._debug(req,"Queing request to "+req.url+". Got number #"+self.requestQueues[req.cacheKey].length);
				return self.requestQueues[req.cacheKey].push({req: req, res: res});				
			}
			self.requestQueues[req.cacheKey] = [{req: req, res: res}];
			return self._proxyNext(req.cacheKey);

		}
		else {

			// No cache key or cacheTTL is zero, just proxy everything!
			return self.proxy.proxyRequest(req,res,req.backendURL,null,{},{cache:self.cache,cacheKey:req.cacheKey},function(err,req,res,preq,pres,infos){
				self._finishRequest(req,res,infos);
			});

		}

	});
}


// Proxy the next request on the list of waiting requests and serve the other ones
function _proxyNext(cacheKey) {

	var
		self = this,
		next = self.requestQueues[cacheKey].shift(),
		req  = next.req,
		res	 = next.res;

	self._debug(req,"Performing proxy request to "+req.backendURL+" ("+req.cacheKey+")");
	return self.proxy.proxyRequest(req,res,req.backendURL,null,{},{cache:self.cache,cacheKey:req.cacheKey},function(err,req,res,preq,pres,infos){

		// Finish the request
		self._finishRequest(req,res,infos);

		// Do we have other queued requests for the same cache key?
		if ( self.requestQueues[cacheKey] ) {

			// The key is there but the queue is empty, make sure we delete it
			if ( self.requestQueues[cacheKey].length == 0 )
				delete self.requestQueues[cacheKey];

			// Serve all the other requests from cache
			else {
				self._serveWaitingRequests(req.cacheKey,req.cacheTTL);
			}

		}
	});

}


// Serve waiting requests for a specific cache key
function _serveWaitingRequests(cacheKey,cacheTTL) {

	var
		self = this,
		waitingQueue;

	// Is it cached ?
	return self.cache.check(cacheKey,cacheTTL,function(err,isCached){
		if ( err ) {
			console.log("WARN: Error checking if item '"+cacheKey+"' is in cache. Please fix it: ",err);
			return self._proxyNext(cacheKey);
		}

		if ( !isCached ) {
			console.log("WARN: After caching the response, it is not in cache - maybe it has expired");
			return self._proxyNext(cacheKey);
		}

		// Serve it from cache
		return self.cache.get(cacheKey,function(err,resLine,stream){
			if ( err ) {
				console.log("ERROR: Error getting item '"+cacheKey+"' from cache after confirming that it was there. Please fix it: ",err);
				return self._proxyNext(cacheKey);
			}

			// Get the waiting request queue
			waitingQueue = self.requestQueues[cacheKey].slice(0);

			// Remove the waiting customers from the list
			delete self.requestQueues[cacheKey];

			// Send the cached data
			waitingQueue.forEach(function(customer){
				resLine.headers['x-cache'] = 'HIT';
				customer.res.writeHead(resLine.statusCode,resLine.headers);
			});
			var docSize = 0;
			stream.on('data',function(d){
				docSize += d.length;
				waitingQueue.forEach(function(customer){
					customer.res.write(d);
				});
			});

			// Finish the responses/requests
			stream.on('end',function(){
				waitingQueue.forEach(function(customer){
					customer.res.end();
					return self._finishRequest(customer.req,customer.res,{docSize: docSize, flags: ['Q','C']});
				});
			});
		});


	});

}


// Finish a request
function _finishRequest(req,res,infos) {

	var
		self = this;

	self._debug(req,"Finishing request "+req.xRequestID);
	return _if ( self.opts.onFinish,
		function(next) {
			self.opts.onFinish(req,res,infos,next);
		},
		function(){
			_access_log(req,res,infos.docSize||'??',infos.flags||[])
		}
	);

}

// Debug
function _debug(req) {

	if ( !this.opts.debug )
		return;

	var
		args = Array.prototype.slice.call(arguments, 0),
		req = args.shift();

	args.unshift(req.xRequestID);
	console.log.apply(null,args);

}


// Log
var _access_log = function(req,res,length,flags) {

    var
        timeSpent = new Date().getTime() - req.xConnectDate.getTime();

    if ( !flags )
        flags = [];

    console.log(req.xRemoteAddr+(req.xDirectRemoteAddr?"/"+req.xDirectRemoteAddr:"")+" - "+req.xRequestID+" ["+req.xConnectDate.toString()+"] \""+req.method+" "+(req.originalURL || req.url)+" HTTP/"+req.httpVersionMajor+"."+req.httpVersionMajor+"\" "+res.statusCode+" "+(length||"-")+" "+(timeSpent / 1000).toString()+" "+(flags.join('')||""));

};


// Merge
var _merge = function(a,b){

    var o = {};
    if ( a != null ) {
        for ( var p in a )
            o[p] = a[p];
    }
    if ( b != null ) {
        for ( var p in b )
            o[p] = b[p];
    }
    return o;

};

// The magic if
var _if = function(cond,a,b) {

	return cond ? a(b) : b();

}


// Export myself
module.exports = ProxyCache;
