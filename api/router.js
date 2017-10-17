const express = require('express');
const jsonParser = require('body-parser').json();
const {BasicStrategy} = require('passport-http');
const passport = require('passport');

const {UserAccount, Entry} = require('./models');
const {nlpCategorize} = require('./nlp');

const router = express.Router();
const Entries = Entry;          // I hate mongoose's naming conventions
const UserAccounts = UserAccount;

router.use(jsonParser);

const strategy = new BasicStrategy((username, password, cb) => {
    let user;
    return UserAccounts
        .findOne({username: username})
        .exec()
        .then(user => {
            if (!user)
                return cb(null, false, {message: 'Incorrect username'});
            return user.validatePassword(password)
                .then(isValid => {
                    if (!isValid)
                        return cb(null, false, {message: 'Incorrect password'});
                    return cb(null, user); // success!
                });
        })
        .catch(err => cb(err));
});

passport.use(strategy);
router.use(passport.initialize());

function checkFields(body, fields) {
    // checks for presence of fields[i] in our request body
    for (let field of fields) {
        if (!body.hasOwnProperty(field))
            return `Missing "${field}" in request body`;
    }
    return false;
}


// ENDPOINTS:
// /entries/.* endpoints
router.get('/entries/', passport.authenticate('basic', {session: false}), (req, res) => {
    // this returns an array of the authenticated user's notes entries
    // The simplest way to add entries (see, POST) is to just push onto the end
    // of an array of post ids; the result is sorted with oldest posts, first.
    // This isn't quite what we want, hence `entries.posts.reverse()`, below.
    return UserAccounts
        .findOne({username: req.user.username}, 'posts')
        .populate('posts')
        .then(entries => {
            entries = entries.posts.reverse();
            res.json(entries.map(entry => entry.apiRepr()));
        })
        .catch(err => res.sendStatus(500));
});

router.get('/entries/:id', passport.authenticate('basic', {session: false}), (req, res) => {
    // this returns the entry with the specific id, assuming it belongs to the authenticated user
    return Entries
        .findById(req.params.id)
        .exec()
        .then(entry => {
            if (req.user.username === entry.author)
                res.json(entry.apiRepr());
            else
                res.sendStatus(403);
        })
        .catch(err => res.sendStatus(500));
});

router.post('/entries/', passport.authenticate('basic', {session: false}), (req, res) => {
    // submits/saves an entry, associated with the given user account
    const fieldMissing = checkFields(req.body, ['title','body']);
    if (fieldMissing) {
        return res.status(400).json(fieldMissing);
    }

    const title = req.body.title.trim();
    const body = req.body.body.trim();
    return nlpCategorize(title + '. ' + body)
        .then(nlpTopics => Entries
              .create({
                  author: req.user.username,
                  title,
                  body,
                  nlpTopics,
              })
              .then(entry => {
                  UserAccounts
                      .findOne({username: req.user.username})
                      .exec()
                      .then(user => {
                          user.posts.push(entry._id);
                          user.save();
                      });

                  return entry;
              })
              .then(entry => res.status(201).json(entry.apiRepr()))
              .catch(() => res.sendStatus(500)));
});

router.put('/entries/:id', passport.authenticate('basic', {session: false}), (req, res) => {
    // for editing an entry--either its `title' and/or its `body'
    if (!(req.params.id && req.body.id && req.params.id === req.body.id)) {
        res.status(400).json({ error: 'Request\'s PATH id and BODY id values must match' });
    }
    const updated = {};
    const updateableFields = ['title', 'body'];
    updateableFields.forEach(field => {
        if (field in req.body) {
            updated[field] = req.body[field].trim();
        }
    });

    return Entries.findById(req.params.id)
    // make sure the author is the one editing the entry
        .then(entry => {
            if (req.user.username !== entry.author)
                res.sendStatus(403); // 403: Forbidden
            return req.body.title || entry.title;
        })
        .then((title) => {
            nlpCategorize(title + '. ' + req.body.body)
                .then(nlpTopics => {
                    updated.nlpTopics = nlpTopics;
                    updated.lastUpdateAt = Date.now();
                    Entries
                        .findByIdAndUpdate(req.params.id, {$set: updated}, {new: true})
                        .exec()
                        .then(updatedPost => res.status(201).json(updatedPost.apiRepr()));
                });
        })
        .catch(err => res.sendStatus(500));
});

router.delete('/entries/:id', passport.authenticate('basic', {session: false}), (req, res) => {
    // deletes the entry with the given id
    return Entries
        .findByIdAndRemove(req.params.id)
        .exec()
        .then(() => res.status(204).json({message: 'success'}))
        .catch(err => res.status(500).json({error: 'Something went wrong'}));
});

// /user_account/ endpoints
router.get('/user_account/', passport.authenticate('basic', {session: false}), (req, res) => {
    // returns the user-relevant data associated with the authenticated user
    return UserAccounts
        .findOne({username: req.user.username})
        .populate('posts')
        .then(userData => res.json(userData.apiRepr()))
        .catch(err => res.status(500).json({error: 'Something went wrong'}));
});

router.post('/user_account/', (req, res) => {
    // creates a user account, with username: username, and password: password
    const fieldMissing = checkFields(req.body, ['username', 'password']);
    if (fieldMissing) {
        return res.status(400).json({error: fieldMissing});
    }
    return UserAccounts.hashPassword(req.body.password.trim())
        .then(hash => {
            UserAccounts
                .create({
                    username: req.body.username.trim(),
                    password: hash
                })
                .then(user => res.status(201).json(user.apiRepr()))
                .catch(err => {
                    if (err.name == 'ValidationError')
                        res.status(422).json({message: err.errors.username.message});
                    else
                        // I'm not sure I want the server exposing whether accounts exist
                        res.status(500).json({message: 'Something went wrong'});
                });
        });
});

router.put('/user_account/', passport.authenticate('basic', {session: false}), (req, res) => {
    // used solely to update a user's password
    const fieldMissing = checkFields(req.body, ['username','newPassword']);
    if (fieldMissing) {
        return res.status(400).json({error: fieldMissing});
    }
    return UserAccounts.hashPassword(req.body.newPassword.trim())
        .then(hash => {
            UserAccounts
                .update(
                    {username: req.user.username.trim()},
                    // {$set: {'password': req.body.newPassword.trim()}},
                    {$set: {'password': hash}},
                    {runValidators: true}
                )
                .then(updated => res.sendStatus(204))
                .catch(err => res.sendStatus(500));
        });
});

router.delete('/user_account/', passport.authenticate('basic', {session: false}), (req, res) => {
    // deletes entries and the authenticated user account
    const p1 = Entries
              .remove({author: req.user.username})
              .exec();
    const p2 = UserAccounts
              .remove({username: req.user.username})
              .exec();

    return Promise.all([p1, p2])
        .then(() => res.sendStatus(204)) // Success!
        .catch(err => res.sendStatus(500));
});

module.exports = {router};
