#!/usr/bin/env node

/*
 TODO:
 	- Make a map of currently cache items in use and discard the expired ones
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
