// api/me.js
// Lets the admin frontend ask "am I still logged in?" (e.g. after the
// 7-day session expires) without triggering a 401 console error.
const { isAuthenticated } = require('../lib/auth');

module.exports = async (req, res) => {
  res.status(200).json({ authenticated: isAuthenticated(req) });
};
