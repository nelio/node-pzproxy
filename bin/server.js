#!/usr/bin/env node

const AWS = require('aws-sdk');
const config = require('config');
AWS.config.update({region: config.region});
const ddb = new AWS.DynamoDB({apiVersion: '2012-08-10'});

const PZProxy = require('../lib/pzproxy');

const outputFilter = (allData, req, res, preq, pres) => {
	const rx = JSON.parse(allData);
	const params = {
		TableName: config.tableName,
		Key: {
			'pid': { N: rx.id.toString() }
		}
	};
	return new Promise((resolve, reject) => {
		ddb.getItem(params, (err, data) => {
			if (err) {
				console.log("Error", err);
				rx.images.shots = ["in","cu","bk"];
				resolve(JSON.stringify(rx));
			} else {
				rx.images.shots = data.Item.shots.SS;
				console.log("Success", data.Item.shots.SS);
				resolve(JSON.stringify(rx));
			}
		});

	});
}

const proxy = new PZProxy({
	serverOpts: {
		port: 3000
	},
	proxyOpts: {
		target: config.backendTarget
	},
	defaultTTL: 30
});
