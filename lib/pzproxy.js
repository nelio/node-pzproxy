var
    Cache  = require('./cache'),
    Proxy  = require('./proxy'),
    Server = require('./server');


function ProxyCache(opts) {

	if ( !opts )
		opts = {};
	this.opts = opts;

	// The default request handler
	opts.onRequest = function(req,res,cb){
		return cb();
	};

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

		// Call the request handler and make it flow
		return opts.onRequest(req,res,function(){self.flowRequest(req,res);});

	});


	// Self methods
	this.flowRequest = _flowRequest;

}

// Handle a request (lookup on cache and proxy)
function _flowRequest(req,res) {

	var
		self = this;

	// Do we have a backendURL ? Build one!
	if ( !req.backendURL ) {
		if ( self.proxy.opts.target )
			req.backendURL = require('url').resolve(self.proxy.opts.target,req.url);
		else
			throw new Error("You haven't defined neither a req.backendURL nor a proxyOpts.target");
	}


	// Is it cached ?
	return self.cache.check(req.cacheKey,req.cacheTTL,function(err,isCached){
		if ( err ) {
			console.log("Error checking if item '"+cacheKey+"' is in cache. Please fix it: ",err);
			res.writeHead(500,{'content-type':'text/plain'});
			res.write('500.1 - Cache check error');
			return;
		}

		if ( isCached ) {

			// Serve it from cache
			return self.cache.get(req.cacheKey,function(err,resLine,stream){
				if ( err ) {
					console.log("Item '"+cacheKey+"' is cached but got an error while trying to get it: ",err);
					res.writeHead(500,{'content-type':'text/plain'});
					res.write('500.2 - Cache retrieve error');
					return;
				}

				// Send the cached data
				res.writeHead(resLine.statusCode,resLine.headers);
				var docSize = 0;
				stream.on('data',function(d){
					docSize += d.length;
				});
				stream.on('end',function(){
					_access_log(req,res,docSize||'??',['C'])
				});
				stream.pipe(res);
			});
		}

		// Not cached, just proxy and cache

//		console.log("Proxying "+req.url+" to "+req.backendURL);
		return self.proxy.proxyRequest(req,res,req.backendURL,null,{},{cache:self.cache,cacheKey:req.cacheKey},function(err,req,res,preq,pres,infos){
			_access_log(req,res,infos.docSize||'??',infos.flags);
		});
	});
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

// Export myself
module.exports = ProxyCache;
