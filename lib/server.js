const http = require('http');
const https = require('https');

class Server {
    constructor(opts = {}) {
        let self = this;

        self._events = {};
        self.reqSeq = 0;

        self._handleRequest = (req, res) => {
            let now = new Date();
            req.xConnectDate = now;

            req.xRequestID = (self.reqSeq++) + '-' + process.pid.toString()
                + '-' + now.getYear() + now.getMonth() + now.getDay() + now.getHours() + now.getMinutes();

            req.xRemoteAddr =
                req.connection.remoteAddress
                || ((req.client && req.client._peername) ? req.client._peername.address : '0.0.0.0');

            self.emit('request', req, res);
        };

        // Event registering
        self.on = (what, cb) => {
            if (!self._events[what]) {
                self._events[what] = [];
            }
            self._events[what].push(cb);
        };
        self.emit = (what, arg1, arg2) => {
            if (!self._events[what]) {
                return;
            }
            self._events[what].forEach((cb) => {
                cb(arg1, arg2);
            });
        };

        opts.proto = opts.proto || 'http';
        opts.address = opts.address || '0.0.0.0';
        opts.port = opts.port || 8080;

        // Create the server
        self._server = (opts.proto === 'https') ? https.createServer(opts, self._handleRequest) :
            (opts.proto === 'fastcgi') ? require('fastcgi-server').createServer(self._handleRequest) :
                http.createServer(self._handleRequest);

        if (opts.address.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/)) {
            console.log('Listening on ' + opts.address + ':' + opts.port);
            self._server.listen(opts.port, opts.address);
        }
        else {
            console.log('Listening on ' + opts.address);
            self._server.listen(opts.address);
        }
    }

    close(){
        console.log("Terminating server");
        this._server.close();
    }
}

module.exports = Server;
