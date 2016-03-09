#!/usr/bin/env node

/*
 TODO:
 	- Lock+Queue similar requests
 	- Make a map of currently cache item in use and discard them
 	- Move cache+proxy login to cacheproxy.js
 	- Use SW4 heads for cache key and URL
 	- Configurable number of backend connection sockets
 */

"use strict";

var
	PZProxy		= require('../lib/pzproxy'),
	proxy;


// Create a proxy instance
proxy = new PZProxy({
	serverOpts: {
		port: 9999
	},
	cacheOpts: {
		storage: "/tmp"
	},
	proxyOpts: {
		target: "http://www.google.com/"
	},
	defaultTTL: 30
});
