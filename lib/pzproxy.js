const Proxy  = require('./proxy');
const Server = require('./server');
const debug = require('debug')('pzproxy.js');

class PzProxy{
    constructor(opts = {}){
        this.opts = opts;

        // The default request handler
        if (!opts.onRequest) {
            opts.onRequest = (req, res, cb) => cb();
        }

        // The default request-finish handler
        if ( !opts.onFinish ) {
            opts.onFinish = (req,res,infos,cb) => cb();
        }

        // The default logAccess function
        this.logAccess = opts.logAccess || PzProxy._logAccess;

        // Default request timeout
        this.defaultTimeout = opts.defaultTimeout || 60;

        // Do we have a proxy instance ? Create the default one
        if ( !opts.proxy ) {
            opts.proxy = new Proxy(Object.assign({}, opts.proxyOpts));
        }

        // Do we have a server instance ? Create the default one
        if ( !opts.server ) {
            opts.server = new Server(opts.serverOpts||{port:opts.port||8080});
        }

        this.proxy  = opts.proxy;
        this.server = opts.server;

        // Listen for a request
        let self = this;
        self.server.on('request', (req,res) => {

            // Proxy and hold counters
            req.xProxyCount = 0;
            req.xProxyTime = 0;
            req.xHoldCount = 0;
            req.xHoldTime  = 0;

            // Useful methods
            // Just answer
            res.answer = (status,headers,data,flags) => {
                res.writeHead(status,headers);
                if (data) {
                    res.write(data);
                }
                res.end();
                self._finishRequest(req, res, {docSize: data ? data.length : 0, flags: (flags || ['s'])});
            };

            // Call the request handler and make it flow
            return opts.onRequest(req, res, () => self.flowRequest(req, res));

        });

    }

    flowRequest(req,res) {
        let self = this;

        PzProxy._debug(req,`Flowing to ${req.url}`);

        // Do we have a backendURL ? Build one!
        if ( !req.backendURL ) {
            if ( self.proxy.opts.target ) {
                req.backendURL = require('url').resolve(self.proxy.opts.target,req.url);
            } else {
                throw new Error('You haven\'t defined neither a req.backendURL nor a proxyOpts.target');
            }
        }

        return self._proxyRequest(req, res, (err, infos) => {
            self._finishRequest(req, res, infos);
        });

    }

    _proxyRequest(req, res, callback) {

        let self = this;
        let startTime = new Date();

        // Count that proxy request
        req.xProxyCount++;

        // Proxy the request
        return self.proxy.proxyRequest(req, res, req.backendURL, {
            timeout: self.defaultTimeout
        }, (err, req, res, preq, pres, infos) => {

            // Add the time spent on that request
            req.xProxyTime += new Date() - startTime;

            // Return
            return callback(err, infos);
        });


    }

    _finishRequest(req,res,infos) {

        let self = this;

        // Mark the request as finished (avoids finishing the same request twice
        // - can happen by using res.answer() internally)
        if ( req._finished ) {
            return;
        }
        req._finished = true;

        PzProxy._debug(req,'Finishing request '+req.xRequestID);

        const markFinished = (next) => {
            self.opts.onFinish(req, res, infos, next);
        };

        const logAccess = () => {
            self.logAccess(req,res,infos.docSize||'??',infos.flags||[]);
        };

        return self.opts.onFinish ? markFinished(logAccess) : logAccess();

    }

    static _debug(req,...args) {
        args.unshift(req.xRequestID);
        debug.apply(null,args);
    }

    static _logAccess(req,res,length,flags = []) {
        const timeSpent = new Date().getTime() - req.xConnectDate.getTime();

        process.stdout.write(req.xRemoteAddr + (req.xDirectRemoteAddr ? '/'
            + req.xDirectRemoteAddr : '') + ' - ' + req.xRequestID + ' [' + req.xConnectDate.toString() + '] "'
            + req.method + ' ' + (req.originalURL || req.url)
            + ' HTTP/' + req.httpVersionMajor + '.' + req.httpVersionMajor
            + '" ' + res.statusCode + ' ' + (length || '-') + ' ' + (timeSpent / 1000).toString() + ' '
            + (flags.join('') || '') + '\n');

    }

    close() {
        this.server.close()
    }
}

module.exports = PzProxy;
