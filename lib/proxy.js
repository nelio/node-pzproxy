#!/usr/bin/env node

/*
 TODO:
     - Lock+Queue similar requests
     - Atomic file writing (write to temp and move)
     - Tidy stuff
 */

"use strict";

var
    http        = require('http'),
    https        = require('https'),
    fs            = require('fs'),
    crypto        = require('crypto'),

    CACHEDIR    = "./data";


// A proxy instance
function Proxy(opts) {

    // Check our options
    if ( !opts )
        opts = {};
    this.opts = opts;

	// Cache plugin
	if ( opts.cache )
		this.cache = opts.cache;

    // Parse the target
    if ( opts.target ) {
        if ( !opts.target.match(/^https?:\/\//) )
            opts.target = "http://"+opts.target;
        opts.target = require('url').parse(opts.target);
    }

	// My methods
    this.proxyRequest = proxyRequest;

}


// Proxy a request
function proxyRequest(req,res,hostOrURL,port,opts,callback){

    var
        self        = this,
        args        = Array.prototype.slice.call(arguments, 0),
        timeout     = null,
        fired       = false,
        docSize     = 0,
        _opts       = {},
        cacheItem   = null,
        url;

    // Get the arguments
    req         = args.shift();
    res         = args.shift();
    hostOrURL   = args.shift();
    callback    = args.pop() || function(){};
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
        if ( fired )
            return;
        if ( timeout )
            clearTimeout(timeout);

        // Should I cache?
        if ( self.cache ) {
            delete pres.headers['Transfer-Encoding'];
        	cacheItem = self.cache.add(opts.cacheKey || opts.url);
        	cacheItem.writeHeaders({statusCode: pres.statusCode, headers: pres.headers});
        }

        // Write the head
        pres.headers['x-cache'] = 'MISS';
        res.writeHead(pres.statusCode,pres.headers);

        // If we have to filter the output, gather all the data, filter it and send it
        if ( typeof self.outputFilter == "function" ) {
            var allData = null;
            pres.on('data',function(data){
                var newB = new Buffer(((allData != null)?allData.length:0)+data.length);
                if ( allData != null )
                    allData.copy(newB,0,0,allData.length);
                data.copy(newB,(allData != null)?allData.length:0,0,data.length);
                allData = newB;
            });
            pres.on('end',function(){
                var d = self.outputFilter(allData,req,res,preq,pres);
                if ( d == null )
                    d = allData;
                docSize = d.length;

                // Write the data and finish it
                res.write(d);
                res.end();

                // Run the callback
                return callback ? callback(null,req,res,preq,pres,{docSize: docSize, flags: ['P','F']}) : null;
            });
        }
        else {

            // Do we have cache ?
            if ( self.cache ) {
                // Get the data and send it to cache at the same time
                pres.on('data',function(chunk){
                    cacheItem.write(chunk);
                    res.write(chunk);
                });
                pres.on('end',function(){
                    res.end();
                	cacheItem.end(function(){
	                    // Run the callback
	                    return callback ? callback(null,req,res,preq,pres,{docSize: docSize, flags: ['P']}) : null;
                	});
                });
            }
            else {
                // No cache? Just pipe it to the user!
                var pr = pres.pipe(res);
                pr.on('end',function(){
                    res.end();

                    // Run the callback
                    return callback ? callback(null,req,res,preq,pres,{docSize: docSize, flags: ['P']}) : null;
                });
            }
        }
    });
    preq.on('error',function(e){
        if ( _opts.onError )
            return _opts.onError(e);
        res.writeHead(503,{'content-type':'text/plain; charset=UTF-8'});
        res.write('503 - Gateway error: '+e.toString());
        res.end();
        preq.abort();
        return callback ? callback(null,req,res,preq,pres,{docSize: null, flags: ['E']}) : null;
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


// Export myself
module.exports = Proxy;