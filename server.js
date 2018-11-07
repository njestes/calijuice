var express    = require('express');
var app        = express();
var mysql      = require('mysql');
var async      = require('async');
var bodyParser = require('body-parser');
var dbInfo     = require('./dbInfo.js');

// Constants
var PORT = 8082;
var HOST = '0.0.0.0';

//need parser to read POST requests
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());

//enable crossdomain
app.use(function(req, res, next) {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
	next();
});

//define static path for hosting html/JS site
app.use(express.static(__dirname + '/www'));

//forward paths from route
app.get('/', (req, res) => {
    res.sendFile('index.html');
});

// Retrieve all juicefeed infos
app.get('/juice', function (req, res) {
    var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    console.log('Request for juice data initiated by:',ip);
	var pool = mysql.createPool(dbInfo.data);
    var untappdQuery = "SELECT * FROM untappd WHERE beertime > NOW() - INTERVAL 60 DAY";
	var instagramQuery = "SELECT * FROM instagram WHERE beertime > NOW() - INTERVAL 60 DAY";
    var twitterQuery = "SELECT * FROM twitter WHERE beertime > NOW() - INTERVAL 60 DAY";
    var beermenusQuery = "SELECT * FROM beermenus WHERE beertime > NOW() - INTERVAL 60 DAY";

    var return_data = {};

    async.parallel([
       function(parallel_done) {
           pool.query(untappdQuery, {}, function(err, results) {
               if (err) return parallel_done(err);
               return_data.untappd = results;
               parallel_done();
           });
       },
       function(parallel_done) {
           pool.query(instagramQuery, {}, function(err, results) {
               if (err) return parallel_done(err);
               return_data.instagram = results;
               parallel_done();
           });
	   },
	   function(parallel_done) {
            pool.query(twitterQuery, {}, function(err, results) {
                if (err) return parallel_done(err);
                return_data.twitter = results;
                parallel_done();
            });
       },
	   function(parallel_done) {
            pool.query(beermenusQuery, {}, function(err, results) {
                if (err) return parallel_done(err);
                return_data.beermenus = results;
                parallel_done();
            });
	   }
    ], function(err) {
		if (err) throw err;
         pool.end();
         res.send(return_data);
    });
});

app.listen(PORT, HOST);
console.log(`Running on http://${HOST}:${PORT}`);
