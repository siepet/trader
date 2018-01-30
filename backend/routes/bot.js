import express from 'express';
import bodyParser from 'body-parser';
import {
  WebClient,
} from '@slack/client';
import request from 'request';
import moment from 'moment';
import firebase from '../db/firebase';
import { slack as config } from '../../config/config';

const db = firebase.firestore();
const router = express.Router();
const urlencodedParser = bodyParser.urlencoded({ extended: false });
const slackWeb = new WebClient(config.botToken);

const sendMessageToSlackResponseURL = (responseURL, JSONmessage) => {
  const postOptions = {
    uri: responseURL,
    method: 'POST',
    headers: {
      'Content-type': 'application/json',
    },
    json: JSONmessage,
  };

  request(postOptions, (error, response, _body) => {
    if (error) {
      // handle errors as you see fit
    }
  });
};

const closeDuplicatedReviewRequests = async (messageId) => {
  const doc = await db.collection('slack_messages').doc(messageId).get();
  const activeReview = doc.data();
  const batch = db.batch();
  const duplicatedRequests = await db.collection('slack_messages')
    .where('gh_pr_id', '==', activeReview.gh_pr_id)
    .where('cr_start_at', '==', null) // check if set
    .get();

  duplicatedRequests.forEach((d) => {
    const { channel_id, ts } = d.data();
    slackWeb.chat.delete(ts, channel_id); // delete duplicates from slack channels
    batch.delete(d.ref); // delete duplicates from firebase
  });

  return batch.commit();
};

router.post('/review', urlencodedParser, (req, res) => {
  res.status(200).end();

  const actionJSONPayload = JSON.parse(req.body.payload);
  console.log('Slack action button payload:', actionJSONPayload);

  if (actionJSONPayload.token !== config.verificationToken) {
    res.status(403).end('Access forbidden');
  } else if (actionJSONPayload.actions[0].name === 'review_done') {
    const messageId = `${actionJSONPayload.channel.id}__${actionJSONPayload.message_ts}`;
    const mEndAt = moment.unix(actionJSONPayload.action_ts);
    const messageRef = db.collection('slack_messages').doc(messageId);
    messageRef.update({
      cr_end_at: mEndAt.toDate(),
    });
    messageRef.get().then((doc) => {
      if (doc.exists) {
        const { cr_start_at: startAt } = doc.data();
        const duration = moment.duration(mEndAt.diff(startAt, 'seconds'), 'seconds').humanize();
        const msg = {
          text: `:white_check_mark: ${actionJSONPayload.original_message.attachments[0].title} - review done by <@${actionJSONPayload.user.name}> in ${duration}`,
          attachments: [],
        };
        sendMessageToSlackResponseURL(actionJSONPayload.response_url, msg); // on review done
      }
    });
  } else {
    const messageId = `${actionJSONPayload.channel.id}__${actionJSONPayload.message_ts}`;
    db.collection('slack_messages').doc(messageId).update({
      cr_start_at: firebase.firestore.FieldValue.serverTimestamp(),
      cr_user_id: actionJSONPayload.user.id,
      cr_user_name: actionJSONPayload.user.name,
    }).then(() => closeDuplicatedReviewRequests(messageId));

    const message = {
      as_user: true,
      replace_original: false,
      text: `${actionJSONPayload.user.name}, do your best to reject! When done, mark this review as finished. :checkered_flag:`,
      callback_id: 'review_done',
    };
    sendMessageToSlackResponseURL(actionJSONPayload.response_url, message); // send info message just for reviewer

    const msg = Object.assign({}, actionJSONPayload.original_message);
    msg.attachments = [
      Object.assign(msg.attachments[0], {
        actions: [{
          name: 'review_done',
          text: ':checkered_flag: Finish review',
          type: 'button',
          value: 'review_done',
        }],
      }),
    ];
    sendMessageToSlackResponseURL(actionJSONPayload.response_url, msg); // on start review - add 'done' button
  }
});

export default router;
