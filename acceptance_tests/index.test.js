const PZProxy = require('../lib/pzproxy');
const axios = require('axios');
const requestImageSize = require('request-image-size');

const instanciateProxy = (backendTarget,outputFilter) => {
    return new PZProxy({
        serverOpts: {
            port: 3000
        },
        proxyOpts: {
            target: backendTarget,
            outputFilter
        },
        defaultTTL: 30
    } );
};

describe('PzProxy without any transformations', () => {
    let server;

    beforeAll( async () => {
        server = await instanciateProxy("http://jsonplaceholder.typicode.com/");
    });

    test('test GET connection to json endpoint', async () => {
        const response = await axios.get(`http://127.0.0.1:3000/todos/1`);
        expect(response.data).toEqual({
            "completed": false,
            "id": 1,
            "title": "delectus aut autem",
            "userId": 1
        });
    });

    test('test HEAD connection to json endpoint', async () => {
        const response = await axios.head(`http://127.0.0.1:3000/todos/1`);
        expect(response.status).toBe(200);
        expect(response.data).toEqual("");
    });

    afterAll(() => {
       server.close();
    });
});

describe('PzProxy with a transformation function being passed', () => {
    let server;

    const outputFilter = (allData) => {

        if(!allData){
            return new Promise((resolve) => {
                resolve();
            });
        }

        const rx = JSON.parse(allData);

        return new Promise((resolve) => {
            if (rx['title']){
                rx['title'] = rx['title'].split('').reverse().join('');
            }
            resolve(JSON.stringify(rx));
        });
    };

    beforeAll( async () => {
        server = await instanciateProxy("http://jsonplaceholder.typicode.com/", outputFilter);
    });

    test('test proxy to json endpoint with output filter', async () => {
        const response = await axios.get(`http://127.0.0.1:3000/todos/2`);
        expect(response.data).toEqual({
            "completed": false,
            "id": 2,
            "title": "iuq aiciffo te silicaf man tu siuq",
            "userId": 1
        });
    });

    test('test HEAD connection to json endpoint', async () => {
        const response = await axios.head(`http://127.0.0.1:3000/todos/2`);
        expect(response.status).toBe(200);
        expect(response.data).toEqual("");
    });


    afterAll(() => {
        server.close();
    });
});


describe('PzProxy with a transformation function being passed', () => {
    let server;

    beforeAll( async () => {
        server = await instanciateProxy("https://cache.mrporter.com/" );
    });

    test('test proxy to image', async () => {
        const response = await requestImageSize(`http://127.0.0.1:3000/variants/images/5983760398719629/in/w960_q80.jpg`);
        console.log(response);
        expect(response.width).toBe(960);
    });

    test('test HEAD connection to image', async () => {
        const response = await axios.head(`http://127.0.0.1:3000/variants/images/5983760398719629/in/w960_q80.jpg`);
        expect(response.status).toBe(200);
        expect(response.data).toEqual("");
    });


    afterAll(() => {
        server.close();
    });
});