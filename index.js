const Botkit = require('botkit');
const BotkitStorage = require('botkit-storage-mongo');
const mongoist = require('mongoist');
const moment = require('moment');
const _ = require('lodash');

const Color = {
  Red: -1,
  Yellow: 0,
  Green: 1,
};
const ColorValue = _.invert(Color);
const ColorCodes = {
  Red: '#E8381E',
  Yellow: '#FFD339',
  Green: '#28E82B',
};

const db = mongoist(process.env.MONGODB_URI).collection('bot');
db.ensureIndex('user');

const controller = Botkit.slackbot({
  storage: BotkitStorage({mongoUri: process.env.MONGODB_URI}),
  debug: process.env.DEBUG,
}).configureSlackApp({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  scopes: ['bot'],
});
const bot = controller.spawn({
  token: process.env.TOKEN,
});

bot.startRTM(function(err, bot, payload) {
  if (err) {
    console.log(err);
  } else {
    bot.api.team.info({}, (err, response) => controller.saveTeam(response.team));
  }
});

controller.setupWebserver(process.env.PORT, function(err, webserver) {
  controller.createWebhookEndpoints(controller.webserver);
});

controller.on('slash_command', function(bot, message) {
  switch (message.command) {
    case '/ryg':
      ryg(bot, message);
      break;
    case '/productivity':
      productivity(bot, message);
      break;
  }
});

const oldest = cursor => cursor.sort({date: 1}).limit(1).next();
const latest = cursor => cursor.sort({date: -1}).limit(1).next();
const rygStatus = (text, last, current, streak, score) => {
  return {
    "attachments": [
      {
        "fallback": text,
        "color": ColorCodes[ColorValue[current.color]],
        "title": "RYG Status",
        "pretext": text,
        "fields": [
          {
            "title": "Last",
            "value": ColorValue[last.color],
            "short": true,
          },
          {
            "title": "Current",
            "value": ColorValue[current.color],
            "short": true,
          },
          {
            "title": "Streak",
            "value": streak,
            "short": true,
          },
          {
            "title": "Week Score",
            "value": score.toFixed(2),
            "short": true,
          },
        ],
      }
    ]
  };
}
const productivityStatus = (weekScores) => {
  return {
    "attachments": weekScores.map(({_id, color, date, score}) => {
      return {
        "fallback": `@${_id}`,
        "color": ColorCodes[ColorValue[color]],
        "title": `<@${_id}>`,
        "fields": [
          {
            "title": "Current",
            "value": ColorValue[color],
            "short": true,
          },
          {
            "title": "Week Score",
            "value": score.toFixed(2),
            "short": true,
          },
        ],
        ts: date.getTime(),
      };
    })
  };
}

async function productivity(bot, message) {
  const weekScores = await db.aggregate([
    {$match: {date: {$gt: moment().subtract(1, 'week').toDate()}}},
    {$sort: {date: 1}},
    {$group: {_id: "$user", color: {$last: "$color"}, date: {$last: "$date"}, score: {$avg: "$color"}}},
  ]);
  bot.replyPublic(message, productivityStatus(weekScores));
}

async function ryg(bot, message) {
  let color;
  switch (message.text.toLowerCase()) {
    case 'red':
    case 'r':
      color = Color.Red;
      break;
    case 'yellow':
    case 'y':
      color = Color.Yellow;
      break;
    case 'green':
    case 'g':
      color = Color.Green;
      break;
    default:
      bot.replyPrivate(message,'Invalid color!');
      return;
  }

  const auth = {user: message.user_name};
  const date = new Date();

  const current = {...auth, color: color, date};
  await db.insert(current);

  const first = await oldest(db.findAsCursor({...auth, date: {$lt: date}}));
  const last = await latest(db.findAsCursor({...auth, date: {$lt: date}}));
  const lastNonGreen = await latest(db.findAsCursor({...auth, date: {$lt: date}, color: {$ne: Color.Green}}));
  const lastGreen = await latest(db.findAsCursor({...auth, date: {$lt: date}, color: {$eq: Color.Green}}));
  const weekScore = (await db.aggregate([
    {$match: {...auth, date: {$gt: moment(date).subtract(1, 'week').toDate()}}},
    {$group: {_id: "$user", score: {$avg: "$color"}}},
  ]))[0].score;

  const withFallback = other => other || first || current;
  const dayStreak = other => moment(withFallback(last).date).diff(withFallback(other).date, 'days');
  const streak = dayStreak(lastNonGreen);
  const drySpell = dayStreak(lastGreen);

  const notifyStreak = () => {
    if (last.color == Color.Green) {
      if (streak)
        bot.replyPublicDelayed(message, `<@${auth.user}> is on a ${streak} days streak! :heart_eyes:`);
    }
  };

  const notifyBreakStreak = () => {
    if (last.color == Color.Green) {
      if (streak)
        bot.replyPublicDelayed(message, `<@${auth.user}> just broke a ${streak} days streak :cry:`);
    } else {
      if (drySpell)
        bot.replyPublicDelayed(message, `<@${auth.user}> is on a ${drySpell} days no-green spell :broken_heart:`);
    }
  };

  const status = text => rygStatus(text, withFallback(last), current, streak, weekScore);

  switch (color) {
    case Color.Red:
      bot.replyPrivate(message, status('Try harder tomorrow!'));
      notifyBreakStreak();
      break;
    case Color.Yellow:
      bot.replyPrivate(message, status('Hope you had a good reason!'));
      notifyBreakStreak();
      break;
    case Color.Green: {
      bot.replyPrivate(message, status('Way to go!'));
      notifyStreak();
      break;
    }
  }
}
