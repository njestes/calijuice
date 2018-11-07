var rp = require('request-promise');
var cheerio = require('cheerio');
var mysql = require( 'mysql' );
var request = require('request');
var Promise = require('bluebird');
var async   = require('async');
var scrapetwitter = require('scrape-twitter');
const { createLogger, format, transports } = require('winston');
var dbInfo = require('./dbInfo.js');
var config = require('./config');

var untappdTableName = 'untappd';
var instagramTableName = 'instagram';
var twitterTableName = 'twitter';
var beermenusTableName = 'beermenus';
var untappdUserURL = 'https://untappd.com/user/';
var untappdVenueURL = 'https://untappd.com/v/';
var untappdSearchURL = 'https://untappd.com/search';
var instagramURL = 'https://www.instagram.com/';
var beermenusURL = 'https://www.beermenus.com/places/';
var numInstagramPosts = 5;
var numTweets = 10;
var dataExp = /window\._sharedData\s?=\s?({.+);<\/script>/;
var daysToExpire = 100;
var twitterCount = 0;
var untappdVenueCount = 0;
var untappdUserCount = 0;
var instagramCount = 0;
var beermenusCount = 0;

var args = process.argv.slice(2);
var logLevel = args[0] || 'info';

var logger = createLogger({
    level: logLevel,
    format: format.simple(),
    transports: [new transports.Console()]
});

class Database {
    constructor( config ) {
        this.connection = mysql.createConnection( config );
    }
    query( sql, args ) {
        return new Promise( ( resolve, reject ) => {
            this.connection.query( sql, args, ( err, rows ) => {
                if ( err )
                    return reject( err );
                resolve( rows );
            } );
        } );
    }
    close() {
        return new Promise( ( resolve, reject ) => {
            this.connection.end( err => {
                if ( err )
                    return reject( err );
                resolve();
            } );
        } );
    }
}

Database.execute = function( config, callback ) {
    var database = new Database( config );
    return callback( database ).then(
        result => database.close().then( () => result ),
        err => database.close().then( () => { throw err; } )
    );
};

var cleanupBeermenus = function() {

    return new Promise(function(resolve, reject){ 

        //create table if it doesn't exist
        var createTableSQL = "CREATE TABLE IF NOT EXISTS `" + beermenusTableName  + "` (uid INT NOT NULL AUTO_INCREMENT PRIMARY KEY,beertime DATETIME,venue TEXT(100),beermenusname VARCHAR(100),name VARCHAR(100),brewery TEXT(100),location TEXT(100),style TEXT(100),ABV TEXT(10),IBU TEXT(10),rating TEXT(10),prices TEXT(100),beerLogoURL TEXT(100),beerUntappdURL TEXT(100),beermenusVenueURL TEXT(100),beermenusLogoURL TEXT(100),venueAddress TEXT(100))";

        //cleanup old records
        var cleanupSQL = "DELETE FROM `" + beermenusTableName  + "` WHERE beertime < NOW() - INTERVAL " + daysToExpire + " DAY";

        Database.execute( dbInfo.data,
            //first query checks if database exists if not creates it
            database => database.query(createTableSQL)
            //second query cleans up old records in database
            .then( rows => {
                return database.query(cleanupSQL);
            } )
        ).then( () => {
            resolve({"result": "Finished beermenus DB cleanup"});

        } ).catch( err => {
            logger.error('there was an error',err);
        } );
    });
};

var getBeermenusVenue = function(venue) {

    return new Promise(function(resolve, reject){ 

        //loop over checkins
        var options = {
            uri: beermenusURL + venue,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 8_0 like Mac OS X) AppleWebKit/600.1.3 (KHTML, like Gecko) Version/8.0 Mobile/12A4345d Safari/600.1.4'
            },
            transform: function (body) {
                return cheerio.load(body);
            }
        };

        //start request promise
        rp(options)
        .then(function ($) {
            var beerInfos = [];
            var testBeerInfos;

            //get venue details
            var venueNameFull = $('.info-wrap').find('h1').text().trim().replace("'","");
            var beerTime = formatDate(new Date($('.caption-small.content-inner').text().trim().replace("'","")));
            var venueAddress = $('span.pure-icon.pure-icon-map-alt.text-blue').parent().text().trim();
            var venueLogoURL = 'https://www.beermenus.com/assets/sprites/logo.png';
            var venueBeerMenusURL = beermenusURL + venue;
   
            var connection = mysql.createConnection(dbInfo.data);

            var beerList = [];
            $('#featured').find('li').each(function(i,beer){
                beerList.push(beer);
            });
                    
            Promise.each(beerList,function (beer) {

                var beerInfo = {};            
                beerInfo.venueNameFull = venueNameFull;
                beerInfo.beertime = beerTime;
                beerInfo.venueAddress = venueAddress;
                beerInfo.beermenusVenueURL = venueBeerMenusURL;
                beerInfo.beermenusLogoURL = venueLogoURL;
                

                beerInfo.beermenusname = $(beer).find('h3').text().trim().replace(/'/g, '');
                var beerTemp = $(beer).find('p.text-gray').text().split('·');
                if (beerTemp.length === 3) {
                    beerInfo.style = beerTemp[0].trim();
                    beerInfo.abv = beerTemp[1].trim();
                    beerInfo.location = beerTemp[2].trim();                    
                }

                beerInfo.prices = $(beer).find('.beer-servings').find('p').text().trim();
                
                //console.log(beerInfo);

                beerInfos.push(beerInfo);

                testBeerInfos = beerInfos.slice(0,1);

            }).then(function(){
                logger.debug('Found ' + beerInfos.length + ' items for ' + beerInfos[0].venueNameFull);

                async.each(beerInfos, function (beerInfo, callback) {
                    //logger.debug(beerInfo)

                    var checkRecordsSQL = "SELECT * FROM `" + beermenusTableName  + "` WHERE beermenusname='" + beerInfo.beermenusname + "' AND venue='" + beerInfo.venueNameFull + "'";  
                    
                    //logger.debug('SQL: ' + checkRecordsSQL);

                    connection.query(checkRecordsSQL, function(err, rows, fields){
                        if(!err){
    
                            //if there are no hits, add it
                            if (rows.length === 0) {
                                logger.debug('Need to add this beer: ' + beerInfo.beermenusname + ' ' + beerInfo.venueNameFull);

                                //go to beer page to get rating
                                var options = {
                                    uri: untappdSearchURL,
                                    qs: {
                                        //remove ipa because causes untappd search issues
                                        q: beerInfo.beermenusname.toLowerCase().replace(' ipa','').replace(' dipa',''),
                                        type: 'beer'
                                    },
                                    headers: {
                                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 8_0 like Mac OS X) AppleWebKit/600.1.3 (KHTML, like Gecko) Version/8.0 Mobile/12A4345d Safari/600.1.4'
                                    },
                                    transform: function (body) {
                                        return cheerio.load(body);
                                    }
                                };

                                //start request promise
                                rp(options)
                                .then(function ($) {

                                    //make sure there are search results
                                    if ($('.results-none').text().indexOf("We didn't find any beers") > 0) {
                                        logger.warn($('.results-none').text());
                                        callback(err);
                                        return;   
                                    }
    
                                    var beer = $('.results-container').find('.beer-item')[0];

                                    beerInfo.rating = parseFloat($(beer).find('.rating').find('.num').text().replace(/\(|\)/g, ""));

                                    beerInfo.name = $(beer).find('.name').text().trim().replace(/'/g, '');
                                    beerInfo.ABV = $(beer).find('.abv').text().replace('ABV','').trim();
                                    beerInfo.IBU = $(beer).find('.ibu').text().replace(' IBU','').trim();

                                    if (beerInfo.IBU === 'No') beerInfo.IBU = 'N/A';
                                    beerInfo.style = $(beer).find('.style').text();

                                    beerInfo.brewery = $(beer).find('.brewery').text().trim().replace(/'/g, '');
                                    beerInfo.beerUntappdURL = 'https://untappd.com' + $(beer).find('.label').attr('href');
                                    beerInfo.beerLogoURL = $(beer).find('.label').find('img').attr('src');
                                  
                                    var insertBeerSQL = "INSERT INTO `" + beermenusTableName + "` (beertime,venue,beermenusname,name,brewery,location,style,ABV,IBU,rating,prices,beerLogoURL,beerUntappdURL,beermenusVenueURL,beermenusLogoURL,venueAddress) VALUES ('" + beerInfo.beertime + "','" + beerInfo.venueNameFull + "','" + beerInfo.beermenusname + "','" + beerInfo.name + "','" + beerInfo.brewery + "','" + beerInfo.location + "','" + beerInfo.style + "','" + beerInfo.ABV + "','" + beerInfo.IBU + "','" + beerInfo.rating + "','" + beerInfo.prices + "','" + beerInfo.beerLogoURL + "','" + beerInfo.beerUntappdURL + "','" + beerInfo.beermenusVenueURL + "','" + beerInfo.beermenusLogoURL + "','" + beerInfo.venueAddress  + "')";
            
                                    connection.query(insertBeerSQL, function(err, rows, fields){
                                        if(!err){
                                            logger.debug("Added beermenus item: " + beerInfo.venueNameFull + ' | ' +  beerInfo.brewery + ' | ' +  beerInfo.name);
                                            callback(null);
                                        } else {
                                            logger.error("Error while performing Query" + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                                            callback(err);
                                        }
                                    });
                                })
                                .catch(function (err) {
                                    logger.error('There was an error getting the user from beermenus for: ' + venue);
                                });
                            }
                            //otherwise 
                            else {
                                logger.debug('Beermenues venue item already exists: ' + beerInfo.venueNameFull + ' ' + beerInfo.beermenusname);
                                callback(null);
                            }
                        } else {
                            logger.error(err);
                            callback(err);
                        }

                    });
                }, function(err){
                    if(err){
                        logger.error(err);
                        connection.end();
                    }else{
                        //logger.debug('finally done');
                        connection.end();
                        resolve(beerInfos);
                    }
                });
            });

    
        }).catch(function (err) {
            logger.error('There was an error getting the beermenues venue for: ' +  venue);
        });
    });
};

var cleanupUntappd = function() {

    return new Promise(function(resolve, reject){ 

        //create table if it doesn't exist
        var createTableSQL = "CREATE TABLE IF NOT EXISTS `" + untappdTableName  + "` (uid INT NOT NULL AUTO_INCREMENT PRIMARY KEY,beertime DATETIME,venue TEXT(100),idx INT,name VARCHAR(100),brewery TEXT(100),style TEXT(100),ABV TEXT(10),IBU TEXT(10),rating TEXT(10),prices TEXT(100),beerLogoURL TEXT(100),beerUntappdURL TEXT(100),venueUntappdURL TEXT(100),venueUntappdLogoURL TEXT(100),venueAddress TEXT(100))";

        //cleanup old records
        var cleanupSQL = "DELETE FROM `" + untappdTableName  + "` WHERE beertime < NOW() - INTERVAL " + daysToExpire + " DAY";

        Database.execute( dbInfo.data,
            //first query checks if database exists if not creates it
            database => database.query(createTableSQL)
            //second query cleans up old records in database
            .then( rows => {
                return database.query(cleanupSQL);
            } )
        ).then( () => {
            resolve({"result": "Finished untappd DB cleanup"});

        } ).catch( err => {
            logger.error('there was an error',err);
        } );
    });
};

var getUntappdMenu = function(venue) {

    return new Promise(function(resolve, reject){ 

            //loop over venues in untappd venue request
        var options = {
            uri: untappdVenueURL + venue,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 8_0 like Mac OS X) AppleWebKit/600.1.3 (KHTML, like Gecko) Version/8.0 Mobile/12A4345d Safari/600.1.4'
            },
            transform: function (body) {
                return cheerio.load(body);
            }
        };

        //start request promise
        rp(options)
        .then(function ($) {

            var beerInfos = [];

            //get venue details
            var venueNameFull = $('.header-details').find('.venue-name').find('h1').text().trim().replace("'","");
            var venueAddress = $('.header-details').find('.address').text().replace("( Map )","").trim();
            var venueUntappdURL = 'https://untappd.com' + $('.header-details').find('.logo').find('a').attr('href');
            var venueUntappdLogoURL = $('.header-details').find('.logo').find('img').attr('src');

            var connection = mysql.createConnection(dbInfo.data);

            //make sure we avoid the 'On deck' menu section
            var beerList = [];
            $('.menu-section').each(function(i,menuSection){
                var category = $(menuSection).find('.menu-section-header').find('h4').clone().children().remove().end().text().trim();

                if (category !== "On Deck") {
                    $(menuSection).find('.menu-section-list').find('li').each(function(i,beer){
                        beerList.push(beer);
                    });
                }
            });
            
            Promise.each(beerList,function (beer) {
    
                var beerInfo = {};            
                beerInfo.venueNameFull = venueNameFull;
                beerInfo.venueUntappdURL = venueUntappdURL;
                beerInfo.venueUntappdLogoURL = venueUntappdLogoURL;
                beerInfo.venueAddress = venueAddress;

                //logger.debug(beerInfo);

                //get beer details
                var $beerDetailsH5 = $(beer).find('.beer-details').find('h5');
                var $beerDetailsH6 = $(beer).find('.beer-details').find('h6');
                
                //check for beers that dont have a number in first 3 characters
                if ($beerDetailsH5.find('a').text().substring(0, 3).indexOf('.') != -1 && !isNaN($beerDetailsH5.find('a').text().charAt(0))) {
                    beerInfo.name = $beerDetailsH5.find('a').text().split('.')[1].trim().replace(/'/g, '');
                    beerInfo.index = parseInt($beerDetailsH5.find('a').text().split('.')[0]);
                }
                else {
                    beerInfo.name = $beerDetailsH5.find('a').text().trim().replace(/'/g, '');
                    beerInfo.index = 0;
                }

                beerInfo.beertime = formatDate(new Date());
                beerInfo.beerLogoURL = $(beer).find('.beer-label').find('img').attr('src');
                var beerDetails = $beerDetailsH6.find('span').text().split('•');
                beerInfo.ABV = beerDetails[0].replace('ABV','').trim();
                beerInfo.IBU = beerDetails[1].replace('IBU','').trim();
                beerInfo.brewery = beerDetails[2].trim().replace("'","");
                beerInfo.style = $beerDetailsH5.find('em').text().replace("'","");
                if ($beerDetailsH6.find('span').last().attr('class')) beerInfo.rating = (parseFloat($beerDetailsH6.find('span').last().attr('class').split('rating xsmall r')[1].trim())/100).toFixed(2);
                else beerInfo.rating = 'N/A';
                beerInfo.beerUntappdURL = 'https://untappd.com' + $beerDetailsH5.find('a').attr('href');
                var prices = [];
                $(beer).find('.beer-prices').find('p').each(function(i,item){
                    prices.push($(item).text().trim());
                });
                beerInfo.prices = prices.join('|');

                //check if there are multiple beers at a single index on menu.  Happens at the ruck where ciders have same index as beers.  Need to find better fix than skipping
                var alreadyHave = false;
                beerInfos.forEach(function (item) {
                    if (item.index === beerInfo.index) alreadyHave = true;
                });

                if (!alreadyHave) beerInfos.push(beerInfo);

                //logger.debug("BEER INDEX:" + beerInfo.index + beerInfo.name)

            }).then(function(){
                //logger.debug('Found ' + beerInfos.length + ' items for ' + beerInfos[0].venueNameFull);
        
                async.each(beerInfos, function (beerInfo, callback) {
                    //logger.debug('beerInfo: ' +  beerInfo)
                        
                    //only do this if this beer has an index
                    if (beerInfo.index != 0) {

                        var checkRecordsSQL = "SELECT * FROM `" + untappdTableName  + "` WHERE idx=" + beerInfo.index + " AND venue='" + beerInfo.venueNameFull + "'";

                        //logger.debug('SQL: ' + checkRecordsSQL);
    
                        connection.query(checkRecordsSQL, function(err, rows, fields){
                            if(!err){
                                //logger.debug(JSON.stringify(rows.length));
            
                                if (rows.length === 0) {
                                    logger.debug('Need to add this beer or update index: ' + beerInfo.index + ' | ' + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                    
                                    var insertBeerSQL = "INSERT INTO `" + untappdTableName  + "` (beertime,venue,idx,name,brewery,style,ABV,IBU,rating,prices,beerLogoURL,beerUntappdURL,venueUntappdURL,venueUntappdLogoURL,venueAddress) VALUES ('" + beerInfo.beertime + "','" + beerInfo.venueNameFull + "','" + beerInfo.index + "','" + beerInfo.name + "','" + beerInfo.brewery + "','" + beerInfo.style + "','" + beerInfo.ABV + "','" + beerInfo.IBU + "','" + beerInfo.rating + "','" + beerInfo.prices + "','" + beerInfo.beerLogoURL + "','" + beerInfo.beerUntappdURL + "','" + beerInfo.venueUntappdURL + "','" + beerInfo.venueUntappdLogoURL  + "','" + beerInfo.venueAddress + "')";
                    
                                    //logger.debug('SQL: ' + insertBeerSQL);
                                    connection.query(insertBeerSQL, function(err, rows, fields){
                                        if(!err){
                                            logger.debug("Added untappd item: " + beerInfo.index + ' | ' + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                                            callback(null);
                                        } else {
                                            logger.error("Error while performing untappd venue insert query: " + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                                            callback(err);
                                        }
                                    });
                                
                                }
                                //this beer at this index needs to be updated
                                else if (rows.length === 1) {
                    
                                    var data = JSON.parse(JSON.stringify(rows[0]));
                    
                                    //chek if we have this entry already
                                    if (data.idx === beerInfo.index && data.name === beerInfo.name && data.venue === beerInfo.venueNameFull) {
                                        logger.debug('Already exists in the DB at this venue at this index: ' + beerInfo.index + ' | ' + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                                        callback(null);
                                    }
                                    //check if new beer at this index
                                    if (data.idx === beerInfo.index && data.name !== beerInfo.name && data.venue === beerInfo.venueNameFull) {
                                        logger.debug('New beer at this venue and index: ' + beerInfo.index + ' | ' + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                    
                                        var updateBeerSQL = "UPDATE `" + untappdTableName  + "` SET beertime='" + beerInfo.beertime + "',idx='" + beerInfo.index + "',name='" + beerInfo.name + "',brewery='" + beerInfo.brewery + "',style='" + beerInfo.style + "',ABV='" + beerInfo.ABV + "',IBU='" + beerInfo.IBU + "',rating='" + beerInfo.rating + "',prices='" + beerInfo.prices + "',beerLogoURL='" + beerInfo.beerLogoURL + "',beerUntappdURL='" + beerInfo.beerUntappdURL + "' WHERE idx='" + beerInfo.index + "' AND venue='" + beerInfo.venueNameFull + "'";
                    
                                        //logger.debug('SQL: ' +  updateBeerSQL);
    
                                        connection.query(updateBeerSQL, function(err, rows, fields){
                                            if(!err){
                                                logger.debug("Updated untappd item: " + beerInfo.index + ' | ' + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                                                callback(null);
                                            } else {
                                                logger.error("Error while performing untapped venue: " + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                                                callback(err);
                                            }
                                        });
                                    }   
                                }
                                //we have a venue that doesn't use indexes so just add the beer
                                else if (rows.length > 1) {
                                    logger.debug('Multiple beers found for this venue at this index: ' + beerInfo.index + ' | ' + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);

                                    callback(null);
                                }
                                else {
                                    logger.error('There was some other error: ' + beerInfo.index + ' | ' + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);

                                    callback(null);
                                }
    
                            } else {
                                logger.error(err);
                                callback(err);
                            }
                        });
                    }

                    //the venue doesn't use indexes
                    else {
                        //logger.debug('THIS VENUE DOESNT USE INDEXES: ' + beerInfo.venueNameFull);

                        var checkRecordsSQL = "SELECT * FROM `" + untappdTableName  + "` WHERE idx=" + beerInfo.index + " AND venue='" + beerInfo.venueNameFull + "' AND name='" + beerInfo.name + "'";

                        //logger.debug('check records SQL: ' + checkRecordsSQL);
    
                        connection.query(checkRecordsSQL, function(err, rows, fields){
                            if(!err){

                                //logger.debug(JSON.stringify(rows.length));
            
                                //query didn't find anything so we need to add a beer
                                if (rows.length === 0) {

                                    logger.debug('Need to add this beer (venue doesnt use index): ' + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                    
                                    var insertBeerSQL = "INSERT INTO `" + untappdTableName  + "` (beertime,venue,idx,name,brewery,style,ABV,IBU,rating,prices,beerLogoURL,beerUntappdURL,venueUntappdURL,venueUntappdLogoURL,venueAddress) VALUES ('" + beerInfo.beertime + "','" + beerInfo.venueNameFull + "','" + beerInfo.index + "','" + beerInfo.name + "','" + beerInfo.brewery + "','" + beerInfo.style + "','" + beerInfo.ABV + "','" + beerInfo.IBU + "','" + beerInfo.rating + "','" + beerInfo.prices + "','" + beerInfo.beerLogoURL + "','" + beerInfo.beerUntappdURL + "','" + beerInfo.venueUntappdURL + "','" + beerInfo.venueUntappdLogoURL  + "','" + beerInfo.venueAddress + "')";
                    
                                    //logger.debug('SQL: ' + insertBeerSQL);

                                    connection.query(insertBeerSQL, function(err, rows, fields){
                                        if(!err){
                                            logger.debug("Added untappd item: " + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                                            callback(null);
                                        } else {
                                            logger.error("Error while performing untappd venue query (no indicies): "  + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                                            logger.error("ERROR:",err)
                                            callback(err);
                                        }
                                    });
                                
                                }
                                //this beer at this index needs to be updated
                                else if (rows.length === 1) {
                                    logger.debug('Already exists (venue doesnt use index): ' + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);

                                    callback(null);
                                }
                                //we have a venue that doesn't use indexes so just add the beer
                                else if (rows.length > 1) {
                                    logger.debug('Multiple beers already exist (venue doesnt use index): ' + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);

                                    callback(null);
                                }
                                else {
                                    logger.error('There was some other error (venue doesnt use index): ' + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);

                                    callback(null);
                                }
    
                            } else {
                                logger.error(err);
                                callback(err);
                            }
                        });

                    }
    
                }, function(err){
                    if(err){
                        logger.error(err);
                        connection.end();
                    }else{
                        //logger.debug('finally done');
                        connection.end();
                        resolve(beerInfos);
                    }
                });   
            });
        })        
        .catch(function (err) {
            logger.error('There was an error getting the menu from untappd for:',venue);
        });
    });
};

var getUntappdUser = function(user) {

    return new Promise(function(resolve, reject){ 

        //loop over checkins
        var options = {
            uri: untappdUserURL + user,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 8_0 like Mac OS X) AppleWebKit/600.1.3 (KHTML, like Gecko) Version/8.0 Mobile/12A4345d Safari/600.1.4'
            },
            transform: function (body) {
                return cheerio.load(body);
            }
        };

        //start request promise
        rp(options)
        .then(function ($) {
            var beerInfos = [];

            //get venue details
            var venueNameFull = $('.user-info').find('.info').find('h1').text().trim().replace("'","");
            var venueUntappdURL = untappdUserURL + user;
            var venueUntappdLogoURL = $('.user-info').find('.avatar-holder').find('img').attr('src');

            var connection = mysql.createConnection(dbInfo.data);

            var beerList = [];
            $('#main-stream').find('.item').each(function(i,beer){
                beerList.push(beer);
            });
                    
            Promise.each(beerList,function (beer) {

                var beerInfo = {};            
                beerInfo.venueNameFull = venueNameFull;
                beerInfo.venueUntappdURL = venueUntappdURL;
                beerInfo.venueUntappdLogoURL = venueUntappdLogoURL;

                beerInfo.beertime = formatDate(new Date($(beer).find('.checkin').find('.feedback').find('.bottom').find('a.time.timezoner.track-click').text()));
                beerInfo.beerUntappdURL = 'https://untappd.com' + $(beer).find('.checkin').find('.top').find('a').attr('href');
                beerInfo.beerLogoURL = $(beer).find('.checkin').find('.top').find('a').find('img').attr('data-original');

                //get checkin details
                beerInfo.prices = $(beer).find('.checkin').find('.comment-text').text().trim();

                var checkinData = [];
                $(beer).find('.checkin').find('.top').find('p').find('a').each(function(i,item) {
                    checkinData.push($(item).text());
                });
                //logger.debug('checkin:' + checkinData)
                beerInfo.name = checkinData[1].trim().replace("'","");
                beerInfo.brewery = checkinData[2].trim().replace("'","");
                beerInfo.index = 0;
                beerInfos.push(beerInfo);

            }).then(function(){
                logger.debug('Found ' + beerInfos.length + ' items for ' + beerInfos[0].venueNameFull);

                async.each(beerInfos, function (beerInfo, callback) {
                    //logger.debug(beerInfo)

                    var checkRecordsSQL = "SELECT * FROM `" + untappdTableName  + "` WHERE beertime='" + beerInfo.beertime + "' AND venue='" + beerInfo.venueNameFull + "'";  
                    //logger.debug('SQL: ' + checkRecordsSQL);

                    connection.query(checkRecordsSQL, function(err, rows, fields){
                        if(!err){
    
                            //if there are no hits, add it
                            if (rows.length === 0) {
                                logger.debug('Need to add this beer or update index: ' + beerInfo.name + beerInfo.venueNameFull + beerInfo.index);

                                //go to beer page to get rating
                                var options = {
                                    uri: beerInfo.beerUntappdURL,
                                    headers: {
                                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 8_0 like Mac OS X) AppleWebKit/600.1.3 (KHTML, like Gecko) Version/8.0 Mobile/12A4345d Safari/600.1.4'
                                    },
                                    transform: function (body) {
                                        return cheerio.load(body);
                                    }
                                };

                                //start request promise
                                rp(options)
                                .then(function ($) {
                                    beerInfo.rating = parseFloat($('.details').find('.rating').find('.num').text().replace(/\(|\)/g, ""));
                                    beerInfo.ABV = $('.details').find('.abv').text().replace('ABV','').trim();
                                    beerInfo.IBU = $('.details').find('.ibu').text().replace(' IBU','').trim();
                                    if (beerInfo.IBU === 'No') beerInfo.IBU = 'N/A';
                                    beerInfo.style = $('.top').find('.name').find('.style').text();

                                    //logger.debug('DATE' + beerInfo.beertime)
                                    
                                    var insertBeerSQL = "INSERT INTO `" + untappdTableName  + "` (beertime,venue,idx,name,brewery,style,ABV,IBU,rating,prices,beerLogoURL,beerUntappdURL,venueUntappdURL,venueUntappdLogoURL) VALUES ('" + beerInfo.beertime + "','" + beerInfo.venueNameFull + "','" + beerInfo.index + "','" + beerInfo.name + "','" + beerInfo.brewery + "','" + beerInfo.style + "','" + beerInfo.ABV + "','" + beerInfo.IBU + "','" + beerInfo.rating + "','" + beerInfo.prices + "','" + beerInfo.beerLogoURL + "','" + beerInfo.beerUntappdURL + "','" + beerInfo.venueUntappdURL + "','" + beerInfo.venueUntappdLogoURL  + "')";
            
                                    connection.query(insertBeerSQL, function(err, rows, fields){
                                        if(!err){
                                            logger.debug("Added untappd item: " + beerInfo.venueNameFull + beerInfo.brewery + beerInfo.name);
                                            callback(null);
                                        } else {
                                            logger.error("Error while performing Query" + beerInfo.venueNameFull + ' | ' + beerInfo.brewery + ' | ' + beerInfo.name);
                                            callback(err);
                                        }
                                    });
                                })
                                .catch(function (err) {
                                    logger.error('There was an error getting the user from untappd for: ' + user);
                                });
                            }
                            //otherwise 
                            else {
                                logger.debug('Untappd user item already exists: ' + beerInfo.venueNameFull + beerInfo.brewery + beerInfo.name);
                                callback(null);
                            }
                        } else {
                            logger.error(err);
                            callback(err);
                        }

                    });
                }, function(err){
                    if(err){
                        logger.error(err);
                        connection.end();
                    }else{
                        //logger.debug('finally done');
                        connection.end();
                        resolve(beerInfos);
                    }
                });
            });

    
        }).catch(function (err) {
            logger.error('There was an error getting the user from untappd for: ' +  user);
        });
    });
};

var cleanupInstagram = function() {

    return new Promise(function(resolve, reject){

        var createTableSQL = "CREATE TABLE IF NOT EXISTS `" + instagramTableName + "` (uid INT NOT NULL AUTO_INCREMENT PRIMARY KEY, beertime DATETIME,user TEXT(100),venue TEXT(100),text VARCHAR(2200) COLLATE utf8_general_ci,venueLogoURL TEXT(200),thumbnailURL TEXT(200),imageURL TEXT(200))";

        var cleanupSQL = "DELETE FROM `" + instagramTableName + "` WHERE beertime < NOW() - INTERVAL " + daysToExpire + " DAY";

        Database.execute( dbInfo.data,
            //first query checks if database exists if not creates it
            database => database.query(createTableSQL)
            //second query cleans up old records in database
            .then( rows => {
                return database.query(cleanupSQL);
            } )
        ).then( () => {
            resolve({"result": "Finished instagram DB cleanup"});

        }).catch( err => {
            logger.error('there was an error getting instagram post: ' + err);
        });
    });
};

var instagramByUser = function(user) {

    return new Promise(function(resolve, reject){
        if (!user) return reject(new Error('Argument "user" must be specified'));

        var options = {
            url: instagramURL + user,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 8_0 like Mac OS X) AppleWebKit/600.1.3 (KHTML, like Gecko) Version/8.0 Mobile/12A4345d Safari/600.1.4',
                "encoding": "text/html;charset='charset=utf-8'"
            }
        };
        
        request(options, function(err, response, body){
            if (err) return reject(err);
    
            var dataString = body.match(dataExp)[1];
            var data = JSON.parse(dataString);
            if (data) {
                           
                var edges = data.entry_data.ProfilePage[0].graphql.user.edge_owner_to_timeline_media.edges;
                var venue = data.entry_data.ProfilePage[0].graphql.user.full_name;
                if (venue === '𝖱𝖮𝖮𝖳 + 𝖡𝖱𝖠𝖭𝖢𝖧 𝖡𝖱𝖤𝖶𝖨𝖭𝖦') venue = 'ROOT + BRANCH BREWING';
                var venueLogo = data.entry_data.ProfilePage[0].graphql.user.profile_pic_url;

                //logger.debug(JSON.stringify(edges));

                async.waterfall([
                    function (callback) {
                        var medias = [];

                        for (i = 0; i < numInstagramPosts; i++) { 
                            var post = edges[i];

                            //logger.debug("Found instagram post for: " + venue);

                            if (post && post.node.edge_media_to_caption.edges[0]) {

                                //clean up hashtags and mentions from text
                                var regexp1 = /\#\w\w+\s?/g;
                                var regexp2 = /\@\w\w+\s?/g;
                                var text = post.node.edge_media_to_caption.edges[0].node.text.split();
        
                                medias.push({
                                    user: user,
                                    venue: venue.replace(/'/g, ""),
                                    venueLogoURL: venueLogo,
                                    text : text[0].replace(/[\u0800-\uFFFF]/g, '').replace(/\n/g,' ').replace(/'/g, ""),
                                    thumbnailURL : post.node.thumbnail_resources[3].src,
                                    imageURL : post.node.display_url,
                                    date : new Date(post.node.taken_at_timestamp * 1000)
                                });

                                
                            }
                        }
                        callback(null, medias);
                    }    
                ], function (err, results) {
                        var response = {
                            total : results.length,
                            medias : results
                        };

                        var connection = mysql.createConnection(dbInfo.data);
                        async.each(results, function (item, callback) {

                            //only process if less than 7 days old
                            var weekInMilliseconds = daysToExpire * 24 * 60 * 60 * 1000;
                            var now = new Date();
                            var postDate = Date.parse(item.date);

                            if ((now - postDate) < weekInMilliseconds) {
                                //logger.debug('POST IS NEWER THAN ONE WEEK');

                                var checkRecordsSQL = "SELECT * FROM `" + instagramTableName  + "` WHERE user='" + item.user + "' AND beertime='" + formatDate(item.date) + "'"; 
                                connection.query(checkRecordsSQL, function(err, rows, fields){
                                    if(!err){
        
                                        //if there are no hits, add it
                                        if (rows.length === 0) {

                                            //logger.debug("DATE: " + formatDate(item.date));
    
                                            //write to database
                                            var insertPostSQL = "INSERT INTO `" + instagramTableName  + "` (beertime,user,venue,text,venueLogoURL,thumbnailURL,imageURL) VALUES ('" + formatDate(item.date) + "','" + item.user + "','" + item.venue + "','" + item.text + "','" + item.venueLogoURL + "','" + item.thumbnailURL + "','" + item.imageURL + "')";
    
                                            //logger.debug('SQL: ' + insertPostSQL);
    
                                            connection.query(insertPostSQL, function(err, rows, fields){
                                                if(!err){
                                                    logger.debug("Inserted Instagram item: " + item.user);
                                                    callback(null);
                                                } else {
                                                    logger.error("Error while performing Instagram Query: " + item.user + ' | ' + item.venue);
                                                    callback(err);
                                                }
                                            });
                                        }
                                        //otherwise 
                                        else {
                                            logger.debug('This instagram post already exists: ' + item.user);
                                            callback(null);
                                        }
                                    } else {
                                        logger.error(err);
                                        callback(err);
                                    }
                                });
                            }

                            //post was older than one week
                            else {
                                logger.debug('This instagram post was older than one week: ' + item.user + ' ' + item.date);
                                callback(null);
                            }

                        }, function(err){
                            if(err){
                                logger.error('Error',err);
                                connection.end();
                            }else{
                                //logger.debug('finally done');
                                connection.end();
                                resolve(response); 
                            }
                        }); 
                });
            }
            else {
                reject(new Error('Error scraping tag page "' + tag + '"'));
            }
        });
    });
};

var cleanupTwitter = function() {

    return new Promise(function(resolve, reject){

        var createTableSQL = "CREATE TABLE IF NOT EXISTS `" + twitterTableName + "` (uid INT NOT NULL AUTO_INCREMENT PRIMARY KEY, beertime DATETIME,user TEXT(100),venue TEXT(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,text VARCHAR(2200) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,userPhotoURL TEXT(200),imageURL TEXT(200)) CHARACTER SET utf8 COLLATE utf8_general_ci";

        var cleanupSQL = "DELETE FROM `" + twitterTableName  + "` WHERE beertime < NOW() - INTERVAL " + daysToExpire + " DAY";

        //set DB charset for emojis, error without this
        dbInfo.data.charset = 'utf8mb4';

        Database.execute( dbInfo.data,
            //first query checks if database exists if not creates it
            database => database.query(createTableSQL)
            //second query cleans up old records in database
            .then( rows => {
                return database.query(cleanupSQL);
            } )
        ).then( () => {
            resolve({"result": "Finished twitter DB cleanup"});

        }).catch( err => {
            logger.error('there was an error getting twitter post: ' + err);
        });
    });
};

var getTwitterByUser = function(user) {

    return new Promise(function(resolve, reject){
        if (!user) return reject(new Error('Argument "user" must be specified'));
    
        //logger.debug('starting twitter scrape: ' + user);

        //first get twitter profile so we can get user logo
        var twitterProfile = new scrapetwitter.getUserProfile(user);
        
        twitterProfile.then(function(profile){
            //logger.debug('profile: ' + profile);

            //then get tweets
            var tweetData = [];
            var twitterStream = new scrapetwitter.TimelineStream(user,{retweets:false,replies:false,count:numTweets});

            twitterStream.on('data', function(tweet) {
                numTweets -=1;
                tweetData.push(tweet);
                //logger.debug(tweet);
            });

            twitterStream.on('end', function() {
                //logger.debug('done getting twitter stream');

                var connection = mysql.createConnection(dbInfo.data);

                async.each(tweetData, function (tweet, callback) {
                    //logger.debug(tweet);

                    var todayDate = new Date();
                    var tweetDate = new Date(tweet.time);

                    //exit loop if tweet is greater than days to expire
                    if (daysToExpire - daysBetween(todayDate,tweetDate) < 0) {
                        logger.debug("Skipping old tweet from: " + tweet.screenName);
                        callback(null);
                        return;
                    }

                    var checkRecordsSQL = "SELECT * FROM `" + twitterTableName  + "` WHERE beertime='" + formatDate(tweetDate)  + "' AND user='" + tweet.screenName + "'";  
                    //logger.debug('SQL: ' + checkRecordsSQL);

                    connection.query(checkRecordsSQL, function(err, rows, fields){
                        if(!err){

                            //if there are no hits, add it
                            if (rows.length === 0) {

                                //logger.debug('Need to add this tweet: ' + tweet.text);
      
                                var insertTweetSQL = "INSERT INTO `" + twitterTableName  + "` (beertime,user,venue,text,userPhotoURL,imageURL) VALUES ('" + formatDate(tweetDate) + "','" + tweet.screenName + "','" + profile.name + "','" + tweet.text.replace("'","").replace("'","") + "','" + profile.profileImage + "','" + tweet.images[0] + "')";

                                //logger.debug('SQL: ' + insertTweetSQL)

                                connection.query(insertTweetSQL, function(err, rows, fields){
                                    if(!err){
                                        logger.debug("Added tweet for: "  + tweet.screenName);
                                        callback(null);
                                    } else {
                                        logger.error("Error while performing Query");
                                        callback(err);
                                    }
                                });
                    
                            }
                            //otherwise 
                            else {
                                logger.debug('Twiter post already exists: '  + tweet.screenName);
                                callback(null);
                            }
                        } else {
                            logger.error(err);
                            callback(err);
                        }

                    });
                }, function(err){
                    if(err){
                        logger.error(err);
                        connection.end();
                    }else{
                        //logger.debug('finally done');
                        connection.end();
                        resolve(null);
                    }
                });
            });
        });        
    });
};

 function daysBetween(d1, d2) {
    var diff = Math.abs(d1.getTime() - d2.getTime());
    return diff / (1000 * 60 * 60 * 24);
}

function formatDate(d) {
    return (d.getFullYear() + "-" + ("00" + (d.getMonth() + 1)).slice(-2)) + "-" + ("00" + d.getDate()).slice(-2) + " " + ("00" + d.getHours()).slice(-2) + ":" + ("00" + d.getMinutes()).slice(-2) + ":" + ("00" + d.getSeconds()).slice(-2);
}

//Instagram
cleanupInstagram().then(function(result){
    logger.info(result.result);
    logger.info('Starting instagram processing...');

    if (config.instagramUsers) config.instagramUsers.forEach(function (item) {
        instagramByUser(item).then(function(result){
            untappdVenueCount +=1;
            logger.info('Finished instagram user: ' + item + ' processed: ' + instagramCount);
        })
        .catch(function(err){
            logger.error('there was an error getting instagram posts: ' + err);
        });
    });
});

//Untappd
cleanupUntappd().then(function(result){
    logger.info(result.result);
    logger.info('Starting untappd processing...');

    if (config.untappdVenues) config.untappdVenues.forEach(function (item) {
        getUntappdMenu(item).then(function(result){
            untappdVenueCount +=1;
            logger.info('Finished untapped venue: ' + item + ' processed: ' + untappdVenueCount);
        })
        .catch(function(err){
            logger.error('there was an error getting untappd venues: ' + err);
        });
    });

    if (config.untappdUsers) config.untappdUsers.forEach(function (item) {
        getUntappdUser(item).then(function(result){
            untappdUserCount +=1;
            logger.info('Finished untapped user: ' + item + ' processed: ' + untappdUserCount);
        })
        .catch(function(err){
            logger.error('there was an error getting untappd users: ' + err);
        });
    });
});

//Twitter
cleanupTwitter().then(function(result){
    logger.info(result.result);
    logger.info('Starting twitter processing...');

    if (config.twitterUsers) config.twitterUsers.forEach(function (item) {
        getTwitterByUser(item).then(function(result){
            twitterCount +=1;
            logger.info('Finished twitter user: ' + item + ' | processed so far: ' + twitterCount);
        })
        .catch(function(err){
            logger.error('there was an error getting twitter posts: ' + err);
        });
    });
});

//Beermenus
cleanupBeermenus().then(function(result){
    logger.info(result.result);
    logger.info('Starting beermenus processing...');

    if (config.beermenusVenues) config.beermenusVenues.forEach(function (item) {
        getBeermenusVenue(item).then(function(result){
            beermenusCount +=1;
            logger.info('Finished beermenus venue: ' + item + ' | processed so far: ' + beermenusCount);
        })
        .catch(function(err){
            logger.error('there was an error getting beermenus venue: ' + err);
        });
    });
});
