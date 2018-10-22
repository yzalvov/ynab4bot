var fs = require('fs')
var readline = require('readline')
const google = require('googleapis')
const gmail = google.gmail('v1')
var googleAuth = require('google-auth-library')

const log = console.log.bind(console)
const Dropbox = require('dropbox')
const uuidv4 = require('uuid/v4')
const util = require('util')
const schedule = require('node-schedule')
const fx = require('money')
const fetch = require('node-fetch')

// If modifying these scopes, delete your previously saved credentials
// at ~/.credentials/gmail-nodejs-quickstart.json
// var SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
var SCOPES = ['https://mail.google.com/'];
var TOKEN_DIR = (process.env.HOME || process.env.HOMEPATH ||
    process.env.USERPROFILE) + '/.credentials/';
var TOKEN_PATH = TOKEN_DIR + 'gmail-nodejs-quickstart.json';



// <<< JOB START  <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
let job = schedule.scheduleJob('01 01 * * * *', () => {

  // Fire up every every hour on 01th second of 01th minute
  // https://www.npmjs.com/package/node-schedule

  // Load client secrets from a local file.
  fs.readFile('gmail-client_secret.json', function processClientSecrets(err, data) {
    if (err) {
      console.log('Error loading client secret file: ' + err)
      return
    }
    // Authorize a client with the loaded credentials, then call the
    // Gmail API.
    // authorize(JSON.parse(data), listLabels);
    // log ( 'gmail-client_secret.json: ' + data )
    authorize(JSON.parse(data), auth => ynb4bot(auth) )
  })

})   
// JOB END >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>



// ########### YNAB 4 BOT #######################################################
// Reads bank transaction notifications via Gmail.
// Adds those TXs to the YNAB4 card account via Dropbox API.
let dbx
let fixerToken
readTokens('secrets.json')
    .then(res => {
        dbx = new Dropbox({ accessToken: res.dropbox })
        fixerToken = res.fixer
    }).catch(err => log(err))

const dbxDir = '2018mynabudget~2abc00c2.ynab4'
const dbxRefFile = 'Budget.ymeta'
const botGUID = 'F97D0907-4C96-4C86-877F-894CFD44EE62'
const botShortId = 'C'


function ynb4bot (auth) {

  const list = util.promisify(gmail.users.messages.list)
  const get = util.promisify(gmail.users.messages.get)
  const modify = util.promisify(gmail.users.messages.modify)
  const query = 'in:inbox is:unread from:notify@vtb.ru "произведена транзакция" +"втб"'

  // Get an array of bank messages via Gmail, break if no messages.
  // Set current ynab settings via Dropbox to an object (path and last tx ver).

  list({
    auth: auth,
    userId: 'me',
    q: query
  })
  .then( lst => {
    if ( !lst.resultSizeEstimate )
      return
      
    // log( lst.messages )
    const ynbInitObj = readYnabFromDbx()
    const msgPrsArr = []

    for (const message of lst.messages) {
      const msgPromise = get({
        auth: auth,
        userId: 'me',
        id: message.id
      })

      msgPrsArr.push( msgPromise )

      modify({
        auth: auth,
        userId: 'me',
        id: message.id,
        resource: {
          removeLabelIds: [ 'UNREAD', 'INBOX' ]
          }
      })

    }

    return Promise.all( [ ynbInitObj, ...msgPrsArr] )

  })

  .then( resArr => {
    if ( !resArr ) {
      log ( `==== NO TX EMAILS FOUND @ ${(new Date()).toISOString().split('.')[0]}Z ====` )
      return
    }

    // Parse the messages and convert currencies if needed.
    // Pass thru the ynab object.
    const [ ynbInitObj, ...msgArr ] = resArr
    const txPromiseArr = []

    // reverse to ascend chrono order
    for (const msg of msgArr.reverse()) {   
      // console.log( parseMessage( msg ) )   
      const tx = toRUB( parseMessage( msg ) )
      txPromiseArr.push ( tx )
    }
    // return

    return Promise.all( [ ynbInitObj, ...txPromiseArr ] )

  }).then ( resArr => {
    if ( !resArr ) { return }

    // Build files and write to Dropbox.

    const [ ynbInitObj, ...txArr ] = resArr
    const fileArr = []
    const dir = ynbInitObj.path

    for (const [i, tx] of txArr.entries()) {
      const txFile = txFileObj( tx, i, ynbInitObj )
      txFile.path = `${dir}${botGUID}/`
      fileArr.push( txFile )

      // log ( txFile.body.items[0].memo )
      // log ( txFile.body.items[0] )

      if ( i === txArr.length-1 ) {
        const botKnowledge = txFile.body.endVersion

        const deviceFile = deviceFileObj( botKnowledge )
        deviceFile.path = `${dir}devices/`
        fileArr.push( deviceFile )
      }
    }

    dbxWriteFiles ( fileArr )

  }).catch( err => console.log(err) )
}


// Sync write files to Dropbox
function dbxWriteFiles ( fileArr ) {
  // start waiting
  let chain = Promise.resolve({
      name: `\n==== Chain of ${fileArr.length-1}+1 (${botShortId}.device) is kicked off @ ${(new Date()).toISOString().split('.')[0]}Z ====`,
      server_modified: ''
  })
  // build a promise chain in the loop
  for ( const file of fileArr ) {
    // const logline = `${file.body.publishTime.slice(0, 10)} ${file.body.items[0].memo} ${file.body.items[0].amount}`
    const body = JSON.stringify(file.body)
    chain = chain.then( res => {
      // log ( `${logline} // ${res.name} ${res.server_modified}` )
      log ( `${res.name} ${res.server_modified}` )
      return dbx.filesUpload({path: `${file.path}${file.name}`, contents:body, mode:'overwrite'})
    })
  }
  // log for the last file
  chain.then(res => {
    log ( `${res.name} ${res.server_modified}` )
    log ( `==== chain of ${fileArr.length-1}+1 (${botShortId}.device) is Dropbox'd @ ${(new Date()).toISOString().split('.')[0]}Z ====\n` )
  })
      // error catcher for the chain
      .catch(err => console.error(err))
}

// read Dropbox token from a file
function readTokens(filename) {
    return new Promise((resolve, reject) => {
        fs.readFile(filename, 'utf8', (err, data) => {
            if (err) {
                reject('Error loading client secret file: ' + err)
            }
            // log ( 'dropbox-secret.json: ' + data )
            // log ( 'accessToken: ' + JSON.parse(data).accessToken )
            resolve(JSON.parse(data))
        })
    })
}

// currency converter via fixer.io
function toRUB(tx) {
    if (['RUR', 'RUB'].includes(tx.currency)) {
        tx.memo = `${tx.time}  --  ${tx.place}  --  `
        tx.spentRUB = tx.amount

        return tx
    } else {
        tx.memo = `${tx.time}  --  ${tx.currency} ${tx.amount}  --  ${tx.place}  --  `

        return fetch(`http://data.fixer.io/api/latest?access_key=${fixerToken}`)
          .then((resp) => resp.json())
          .then((data) => fx.rates = data.rates)
          .then( () => {
            const amount = fx(tx.amount).from(tx.currency).to('RUB')
            tx.spentRUB = amount.toFixed(2)
            return tx
          }).catch(err => log(err))
    }
}

function deviceFileObj (knowledge) {
    const fileStr = `{
      "name": "${botShortId}.ydevice",
      "body": {
        "formatVersion" : "1.2",
        "deviceVersion" : "11.2.1",
        "friendlyName" : "ynab4bot",
        "knowledgeInFullBudgetFile" : null,
        "YNABVersion" : "iOS 3.4.3 (263)",
        "highestDataVersionImported" : "4.2",
        "deviceType" : "iPhone",
        "knowledge" : "${knowledge}",
        "lastDataVersionFullyKnown" : "4.2",
        "shortDeviceId" : "${botShortId}",
        "deviceGUID" : "${botGUID}",
        "hasFullKnowledge" : false
      }
    }`
    return JSON.parse(fileStr)
}

function txFileObj(tx, i, ynbInitObj) {
  const txPostfxArr = ynbInitObj.lastVer.split(',')
  const txLastIdx = txPostfxArr.pop().split('-')[1] * 1
  const txVer = txLastIdx + i // 'i' is 0 for the first tx in the chain
  const txPostfxStr = txPostfxArr.join(',')
  const startVer = `${txPostfxStr},${botShortId}-${txVer}`

  const fileStr = `{
    "name": "${startVer}_${botShortId}-${(txVer + 1)}.ydiff",
    "body": {
      "dataVersion": "4.2",
      "items": [
      {
        "importedPayee": null,
        "checkNumber": "${tx.card}",
        "accepted": true,
        "transferTransactionId": null,
        "categoryId": null,
        "amount": ${-tx.spentRUB},
        "subTransactions": [],
        "memo": "${tx.memo}",
        "payeeId": null,
        "targetAccountId": null,
        "flag": "Purple",
        "isTombstone": false,
        "date": "${tx.publishTime.split(' ')[0]}",
        "dateEnteredFromSchedule": null,
        "entityVersion": "${botShortId}-${(txVer + 1)}",
        "entityType": "transaction",
        "cleared": "Uncleared",
        "madeWithKnowledge": null,
        "accountId": "38BD3739-107E-6B63-AFBE-536BC6BD0414",
        "entityId": "${uuidv4().toUpperCase()}"
      }],
      "publishTime": "${tx.publishTime}",
      "deviceGUID": "${botGUID}",
      "endVersion": "${txPostfxStr},${botShortId}-${txVer + 1}",
      "shortDeviceId": "${botShortId}",
      "budgetDataGUID": "${ynbInitObj.budgetDataGUID}",
      "budgetGUID": "/Apps/ynab4bot/${dbxDir}",
      "startVersion": "${startVer}"
    }
  }`

  return JSON.parse(fileStr)
}

function readYnabFromDbx() {
  const ballObj = {}
  return dbx.filesDownload({ path: `/${dbxDir}/${dbxRefFile}` })
    .then(res => {
        const ynabDataPath = JSON.parse(res.fileBinary).relativeDataFolderName
        ballObj.path = `/${dbxDir}/${ynabDataPath}/`
        ballObj.budgetDataGUID = ynabDataPath
        return lastYdiffPath(ballObj.path)
    })
    .then(res => {
        return ynbEndVer(res)
    })
    .then(res => {
        ballObj.lastVer = res
        return ballObj
    })
    .catch(err => console.log(err))
}

function ynbEndVer(ypath) {
  return dbx.filesDownload({ path: ypath })
    .then(res => {
        return JSON.parse(res.fileBinary).endVersion
    })
    .catch(err => console.log(err))
}

function lastYdiffPath(ypath) {
  return dbx.filesListFolder({ path: ypath })
    .then(res => {
      const recentYdiffs = []
      for (const folder of res.entries) {
        // skip the 'device' folder as there's no .ydiff files
        if (folder.name === 'devices') { continue }
        recentYdiffs.push( folderLastYdiff(ypath, folder) )
      }

      return Promise.all(recentYdiffs)
        .then( res => {
          const recentYdiffs = res.filter( e => e !== undefined )
          const recentYdiffsMap = new Map(recentYdiffs)
          const lastDate = [...recentYdiffsMap.keys()].sort().pop()
          // log ( recentYdiffsMap.get(lastDate) )
          return recentYdiffsMap.get(lastDate)
          })
        }).catch(err => console.log(err) )
}

function folderLastYdiff (ypath, folder) {
   return dbx.filesListFolder({ path: ypath + folder.name })
    .then(res => {
        if ( res.entries.length === 0 ) { return } // skip empty folder
        const recentFirstArr = res.entries.reverse()
        const lastYdiff = recentFirstArr.find( e => e.name.includes('.ydiff') )
        if ( !lastYdiff ) { return } // return nothing if there's no .ydiff file found
        
        return [Date.parse(lastYdiff.client_modified), `${ypath+folder.name}/${lastYdiff.name}`]

    }).catch(err => console.log(err))
}

function parseMessage ( msg ) {
  const body = Buffer.from(msg.payload.body.data, 'base64').toString('utf8')
  const detailsObj = {}
  const fatBait = `\\sпо Вашей банковской карте \\*`
  const timestampRegex = new RegExp(`.{21}(?=${fatBait})`) //=>  /.{21}(?=\sпо Вашей банковской карте \*)/
  const timestamp = body.match(timestampRegex)[0]
  const [date, time] = timestamp.split(' в ')
  const regexPlan = new Map()
    .set(new RegExp(`(${fatBait})`), /.{4}/) //=>  /(\sпо Вашей банковской карте \*)/ /.{4}/
    .set(/(на сумму\s)/, /.+(?=.)/)
    .set(/(Детали платежа:\s)/, /.+(?=.<\/span>)/)
  let rawCatch = []
  for (const [bait, hook] of regexPlan.entries()) {
    const regex = new RegExp(bait.source + hook.source)
    const fish = body.match(regex)[0].replace(bait, '')
    rawCatch = rawCatch.concat([fish])
  }
  const [card, spent, place] = rawCatch
  detailsObj.publishTime = `${date.split('.').reverse().join('-')} ${time}`
  detailsObj.time = time.slice(0, 5)
  detailsObj.card = card
  detailsObj.amount = spent.split(' ')[0]
  detailsObj.currency = spent.split(' ')[1]
  detailsObj.place = place

  return detailsObj
}


// END ###########  YNAB 4 BOT  #####################################







/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 *
 * @param {Object} credentials The authorization client credentials.
 * @param {function} callback The callback to call with the authorized client.
 */
function authorize(credentials, callback) {
  var clientSecret = credentials.installed.client_secret;
  var clientId = credentials.installed.client_id;
  var redirectUrl = credentials.installed.redirect_uris[0];
  var auth = new googleAuth();
  var oauth2Client = new auth.OAuth2(clientId, clientSecret, redirectUrl);

  // Check if we have previously stored a token.
  fs.readFile(TOKEN_PATH, function(err, token) {
    if (err) {
      getNewToken(oauth2Client, callback);
    } else {
      oauth2Client.credentials = JSON.parse(token);
      callback(oauth2Client);
    }
  });
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 *
 * @param {google.auth.OAuth2} oauth2Client The OAuth2 client to get token for.
 * @param {getEventsCallback} callback The callback to call with the authorized
 *     client.
 */
function getNewToken(oauth2Client, callback) {
  var authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES
  });
  console.log('Authorize this app by visiting this url: ', authUrl);
  var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  rl.question('Enter the code from that page here: ', function(code) {
    rl.close();
    oauth2Client.getToken(code, function(err, token) {
      if (err) {
        console.log('Error while trying to retrieve access token', err);
        return;
      }
      oauth2Client.credentials = token;
      storeToken(token);
      callback(oauth2Client);
    });
  });
}

/**
 * Store token to disk be used in later program executions.
 *
 * @param {Object} token The token to store to disk.
 */
function storeToken(token) {
  try {
    fs.mkdirSync(TOKEN_DIR);
  } catch (err) {
    if (err.code != 'EEXIST') {
      throw err;
    }
  }
  fs.writeFile(TOKEN_PATH, JSON.stringify(token));
  console.log('Token stored to ' + TOKEN_PATH);
}