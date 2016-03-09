# node-pzproxy 

A programmable and pluggable HTTP/HTTPS proxy for node.js

## Installing

	npm install pzproxy

## Using it

	"use strict";

	var
	    PZProxy = require('pzproxy');


	// Create a proxy instance
	new PZProxy({
	    serverOpts: {
	        port: 9999
	    },
	    cacheOpts: {
	        storage: "./data"
	    },
	    proxyOpts: {
	        target: "http://www.esquerda.net"
	    },
	    defaultTTL: 30
	});
