const NodeCache = require("node-cache");
const User = require("../models/User"); 

const userProfiles = new NodeCache({ stdTTL: 1800 }); // 30 mins in RAM

async function getUserProfile(phone) {
  let profile = userProfiles.get(phone);

  if (!profile) {
    let dbUser = await User.findOne({ whatsappNumber: phone });
    if (dbUser) {
      profile = { 
        ...dbUser._doc, 
        history: [] 
      };
    } else {
      profile = { 
        name: "Customer", 
        shoeSize: null, 
        history: [], 
        cart: [], 
        recentlyViewed: [] 
      };
      await User.create({ whatsappNumber: phone, ...profile });
    }
    userProfiles.set(phone, profile);
  }
  return profile;
}

async function addMessage(user, role, content) {
  let profile = await getUserProfile(user);
  profile.history.push({ role, content });
  if (profile.history.length > 20) profile.history.shift();
  userProfiles.set(user, profile);
}

async function updateCustomerInfo(user, data) {
  let profile = await getUserProfile(user);
  if (data.name) profile.name = data.name;
  if (data.shoeSize) profile.shoeSize = data.shoeSize;
  
  userProfiles.set(user, profile);
  await User.findOneAndUpdate({ whatsappNumber: user }, data);
}

async function addToCart(user, productName, price) {
  let profile = await getUserProfile(user);
  profile.cart.push({ product: productName, price: price });
  
  userProfiles.set(user, profile);
  await User.findOneAndUpdate({ whatsappNumber: user }, { cart: profile.cart });
}

module.exports = {
  getUserProfile,
  addMessage,
  updateCustomerInfo,
  addToCart
};
