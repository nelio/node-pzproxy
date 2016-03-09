#!/usr/bin/env node

/*
 TODO:
 	- Lock+Queue similar requests
 	- Atomic file writing (write to temp and move)
 	- Tidy stuff
 */

"use strict";

var
	Server		= require('../lib/server'),
	Cache		= require('../lib/cache'),
	Proxy		= require('../lib/proxy'),
	CACHEDIR	= "./data";


// A server instance
function Server(opts) {

	var
		self = this;

	// Self properties
	self._events = {};
	self.reqSeq  = 0;

	// Self methods
	self._handleRequest = function(req,res){
		// Set some basic stuff
		var now = new Date();
		req.xConnectDate = now;
		req.xRequestID = (self.reqSeq++) + "-" + process.pid.toString() + "-" + now.getYear()+now.getMonth()+now.getDay()+now.getHours()+now.getMinutes();
		req.xRemoteAddr = req.connection.remoteAddress || ((req.client && req.client._peername) ? req.client._peername.address : "0.0.0.0");

		// Call the request handler
		self._call('request',req,res);
	};

	// Event registering
	self.on = function(what,cb){
		if ( !self._events[what] )
			self._events[what] = [];
		self._events[what].push(cb);
	};
	self._call = function(what,arg1,arg2){
		if ( !self._events[what] )
			return;
		self._events[what].forEach(function(cb){
			cb(arg1,arg2);
		});
	};

	// Validate options
	if ( !opts.proto )
		opts.proto = "http";
	if ( !opts.address )
		opts.address = "0.0.0.0";
	if ( !opts.port )
		opts.port = 8080;

	// Create the server
	self._server =	(opts.proto == "https")		? https.createServer(opts,_handleRequest) :
					(opts.proto == "fastcgi")	? require('fastcgi-server').createServer(_handleRequest) :
					http.createServer(self._handleRequest);

	// Start it
	self._server.listen(opts.port, opts.address);
	console.log("Listening on "+opts.address+":"+opts.port);

	return self;

}


// Serve the request from cache
var tryServeFromCache = function(req,res,filePath,status,opts,callback) {

    var
        expireDate;

    // Validate
    if ( !opts )
    	opts = {};
    if ( !callback )
    	callback = function(){};


    // Check if the file exists and get it's infos (stat)
    return fs.stat(filePath, function(err, stat) {
        if ( err ) {
        	// Cache file doesn't exist
            if ( err.code == "ENOENT" )
                return callback(null,false);

            return callback(err,null);
        }

        // Cache "file" is not a file
        if ( !stat.isFile() )
        	return callback(new Error("Cache 'file' is not a file"),null);

        // Check the expire date
        if ( opts.notOlderThan ) {
        	expireDate = new Date(stat.mtime.getTime() + opts.notOlderThan*1000);
        	if ( expireDate < new Date() )
        		return callback(new Error("Cache entry has expired"),false);
        }


		// Open file
		return fs.open(filePath,"r",function(err,fd){
			if ( err ) {
				console.log("Error openning cache file '"+filePath+"': ",err);
				return callback(err,null);
			}

			// Read the headers
			return _readCacheFileHeaders(fd,function(err,resLine){
				if ( err ) {
					console.log("Error reading cache file headers: ",err);
					return callback(err,null);
				}

				// I sent it like I want!
				delete resLine.headers['Transfer-Encoding'];

				// Hack some headers
				resLine.headers['date'] = new Date().toUTCString();
				resLine.headers['server'] = 'PIPServer/0.1';
				resLine.headers['x-from'] = 'Cache';
				resLine.headers['x-cache-expires'] = expireDate ? expireDate.toUTCString() : 'never';


		        // Send the http response head
		        return _writeHead(res,resLine.statusCode || 200,resLine.headers,function(){

		            // Send the file
		            return _pipeStream(res,fs.createReadStream(null,{fd:fd}),function(){
		                res.end();

		                // Log
		                _access_log(req,res,stat.size,['C']);

		                // Callback
		                return callback(null,true);
		            });

		        });
			});
		});
    });

};

// Read cache file headers
var _readCacheFileHeaders = function(fd,callback) {

	var
		_size = new Buffer(4),
		_headers;

	// Read the header size
	fs.read(fd,_size,0,4,null,function(err,rb){
		if ( err ) {
			console.log("Error reading header size from cache file: ",err);
			return callback(err,null);
		}

		if ( rb != 4 ) {
			console.log("Couldn't read the 4 bytes of the header size from cache file");
			return callback(new Error("Couldn't read the 4 bytes of the header size from cache file"),null);
		}

		_size = _sizeBytesToNum(_size);
		_headers = new Buffer(_size);

		// Read the headers
		fs.read(fd,_headers,0,_size,null,function(err,rb){
			if ( err ) {
				console.log("Error reading cache file headers: ",err);
				return callback(err,null);
			}

			// Check the size
			if ( rb != _size ) {
				console.log("Headers size mismatch. Expecting "+_size+" and got "+rb);
				return callback(new Error("Headers size mismatch. Expecting "+_size+" and got "+rb),null);
			}

			// Parse the headers
			try {
				_headers = JSON.parse(_headers.toString());
			}
			catch(ex) {
				console.log("Error parsing headers: ",ex);
				return callback(ex,null);
			}

			// Return
			return callback(null,_headers);
		});

	});

};

// Proxy a request
function proxyRequest(req,res,hostOrURL,port,opts,callback){

    var
        args = Array.prototype.slice.call(arguments, 0),
        url,
        timeout,
        fired = false,
        docSize = 0,
        _opts = {},
        cacheStream;

    // Get the arguments
    req         = args.shift();
    res         = args.shift();
    hostOrURL   = args.shift();
    callback	= args.pop() || function(){};
    opts        = args.pop() || {};
    port        = args.shift();

    // What url ?
    url = (req.url === req.urlNoArgs) ? req.originalURL : req.url;

    // Options with defaults
    _opts = _merge({
        proto:   "http",
        host:    hostOrURL,
        port:    port,
        path:    url,
        headers: req.headers || {}
    },opts||{},true);

    // Trying to proxy a POST request with already read POST data ?
    if ( req.method == "POST" && req._readPOSTData ) {
        var err = new Error("Trying to proxy a POST request with POST data already read. Please supply dontReadPOSTData:true on route options.");
        if ( _opts.onError )
            return _opts.onError(err);
        else
            throw err;
    }

    // Validate and load host/url
    if ( !hostOrURL )
        throw new Error("No host/url to send the request");
    // Host:port
    else if ( hostOrURL.match(/:(\d+)$/) ) {
        _opts.port = parseInt(RegExp.$1);
        _opts.host = hostOrURL.replace(/:.*$/,"");
        _opts.headers.host = _opts.host;
    }
    // URL
    else if ( hostOrURL.match(/^https?:\/\//) ) {
        var u = require('url').parse(hostOrURL);
        _opts.proto = u.protocol.replace(/:.*$/,"");
        _opts.host = u.hostname;
        _opts.headers.host = u.hostname;
        _opts.port = u.port;
        _opts.path = u.path;
    }

    // No port ? defaults to the default protocol port
    if ( !_opts.port )
        _opts.port = (_opts.proto == "https" ? 443 : 80);

    var
        proto = (_opts.proto == "https") ? https : http,
        preq = proto.request({
            host:    _opts.host,
            port:    _opts.port,
            method:  req.method,
            headers: _opts.headers || req.headers,
            path:    _opts.path
        });

    // Timeout event
    if ( _opts.timeout ) {
        timeout = setTimeout(function(){
            preq.abort();
            fired = true;
            if ( _opts.onTimeout )
                return _opts.onTimeout();
            return _writeHead(res,502,{'Content-type':'text/plain; charset=UTF-8'},function(){
                return _writeData(res,'502 - Gateway timeout :-(',true);
            });
        },_opts.timeout);
    }

    // On response arrive
    preq.on('response',function(pres){
    	if ( pres.headers.location )
    		pres.headers.location = pres.headers.location.replace(/^https?:\/\/pypi.python.org/,"");
        if ( fired )
            return;
        if ( timeout )
            clearTimeout(timeout);

        // Should I cache?
        if ( opts.cacheTo ) {
        	// Create a writable stream
        	cacheStream = fs.createWriteStream(opts.cacheTo);

        	// Write the headers to the file
        	var strHeaders = JSON.stringify({statusCode: pres.statusCode, headers: pres.headers});
        	cacheStream.write(_sizeNumToBytes(strHeaders.length));
        	cacheStream.write(strHeaders);
        }

        // Hack the headers
        pres.headers['server'] = 'PIPServer/0.1';
        pres.headers['x-from'] = 'Remote';

        return _writeHead(res,pres.statusCode,pres.headers,function(){
            if ( typeof opts.outputFilter == "function" ) {
                var allData = null;
                pres.on('data',function(data){
                    var newB = new Buffer(((allData != null)?allData.length:0)+data.length);
                    if ( allData != null )
                        allData.copy(newB,0,0,allData.length);
                    data.copy(newB,(allData != null)?allData.length:0,0,data.length);
                    allData = newB;
                });
                pres.on('end',function(){
                    var d = opts.outputFilter(allData,req,res,preq,pres);
                    if ( d == null )
                        d = allData;
                    docSize = d.length;
                    return _writeData(req,res,d,true,function(){
                        // Run the callback
                        if ( callback )
                            callback(null,true);

                        // Log
                        return _access_log(req,res,pres.headers['content-length']||docSize||'??',['P','F']);
                    });
                });
            }
            else {
            	pres.on('data',function(chunk){
            		if ( cacheStream )
            			cacheStream.write(chunk);
            		res.write(chunk);
            	});
//                var pr = pres.pipe(res);
                pres.on('end',function(){
                	res.end();
                    // Run the callback
                    if ( callback )
                        callback(null,true);

                    // Log
                    return _access_log(req,res,pres.headers['content-length']||docSize||'??',['P']);
                });
            }
        });
    });
    preq.on('error',function(e){
        if ( _opts.onError )
            return _opts.onError(e);
        return _writeHead(res,503,{'content-type':'text/plain; charset=UTF-8'},function(){
            return _writeData(res,'503 - Gateway error: '+e.toString(),true,function(){
                preq.abort();
                return _access_log(req,res,19,['E']);
            });
        });
    });
    if ( req.headers && req.headers['content-length'] )
        req.pipe(preq);
    else
        preq.end();

};


// Merge
var _merge = function(a,b,lcProps){
	var o = {};
	if ( a != null ) {
		for ( var p in a )
			o[lcProps?p.toLowerCase():p] = a[p];
	}
	if ( b != null ) {
		for ( var p in b )
			o[lcProps?p.toLowerCase():p] = b[p];
	}
	return o;
};

var _writeHead = function(res,status,headers,cb){

	res.writeHead(status,headers);
	return cb();

};

// Write the head of an HTTP response
var _writeData = function(res,data,end,callback){

	// Just writing...
	if ( !end ) {
		res.write(data);
		return callback();
	}

	// Write and end
	res.end(data);
	return callback();

}

// Pipe a stream into an HTTP response
var _pipeStream = function(res,stream,callback){

	var
		pr;

	// Pipe the stream
	pr = stream.pipe(res);
	stream.on('end',function(){
		callback(null,true);
	});

};

// Log
var _access_log = function(req,res,length,flags) {
	var
		timeSpent = new Date().getTime() - req.xConnectDate.getTime();

	if ( !flags )
		flags = [];

	console.log(req.xRemoteAddr+(req.xDirectRemoteAddr?"/"+req.xDirectRemoteAddr:"")+" - "+req.xRequestID+" ["+req.xConnectDate.toString()+"] \""+req.method+" "+(req.originalURL || req.url)+" HTTP/"+req.httpVersionMajor+"."+req.httpVersionMajor+"\" "+res.statusCode+" "+(length||"-")+" "+(timeSpent / 1000).toString()+" "+(flags.join('')||""));
};

// Return the MD5 hex of a string
var _md5 = function(str) {

	return crypto.createHash('md5').update(str).digest("hex");

};

// The magic if
var _if = function(cond,a,b) {

	return cond ? a(b) : b();

};

function _sizeBytesToNum(data) {
	return (data[0] << 24) | (data[1] << 16) | (data[2] <<8) | data[3]
}
function _sizeNumToBytes(num,buf,offset) {
	if ( buf == null )
		buf = new Buffer(4);
	if ( offset == null )
		offset = 0;

	buf[offset+0] = (num >> 24) & 0xff;
	buf[offset+1] = (num >> 16) & 0xff;
	buf[offset+2] = (num >> 8) & 0xff;
	buf[offset+3] = num & 0xff;

	return buf;
}


// THE APP STARTS HERE

// Create a server
new Server({port:9999}).on('request',function(req,res){

	var
		cacheKey,
		cacheFile,
		cacheExpire;

	// Remove crap from the URL
	req.url = req.url.replace(/\/\.\./g,"/");


	// Generate the cache key and expire time
	if ( req.url.match(/^\/.+\/([^\/]+\.(tar\.(gz|bz2|xz)|zip|whl))$/i) ) {
		cacheKey = RegExp.$1;
		cacheExpire = null;		
	}
	else {
		cacheKey = _md5(req.url);
		cacheExpire = 10800; // 3 hours
	}
	if ( cacheKey )
		cacheFile = CACHEDIR+"/"+cacheKey;

	// Try to return it from cache
	return tryServeFromCache(req,res,cacheFile,200,{notOlderThan: cacheExpire},function(err,found){
		if ( err ) {
			console.log("Error serving from cache: ",err);
		}

		console.log("Getting: ","https://pypi.python.org"+req.url+" ("+cacheFile+")");
		return proxyRequest(req,res,"https://pypi.python.org"+req.url,null,{},{cacheTo:cacheFile},function(){});
	});

});
