// api/me.js
// Lets the admin screens ask "am I still logged in, and as whom?"
const { readSession } = require('../lib/auth');
const { resolveSession, publicUser } = require('../lib/users');

module.exports = async (req, res) => {
  let person = null;
  try {
    person = await resolveSession(readSession(req));
  } catch {
    person = null;
  }
  res.status(200).json(person ? { authenticated: true, user: publicUser(person) } : { authenticated: false });
};
