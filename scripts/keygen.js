// Makes a brand-new Solana wallet for the treasury and prints it once.
// Nothing is saved to disk and nothing is sent anywhere: copy the key into your host's settings yourself.
//
//   npm run keygen

import { generateKeypair } from '../server/solana.js';

const wallet = generateKeypair();
console.log(`
New treasury wallet

  Address (public, safe to share):
  ${wallet.address}

  Secret key (PRIVATE: whoever has it can take everything in the wallet):
  ${wallet.secretKey}

What to do with it
  1. Paste the secret key into your host's settings as TREASURY_SECRET_KEY. Do not put it in a file you share,
     in a chat, in an email or in git.
  2. Keep one offline copy (a password manager is fine). You can import it into Phantom or Solflare later.
  3. Send SOL to the address above. Start small.
  4. Clear this terminal window when you are done.
`);
