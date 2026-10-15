import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { b58decode, b58encode, isAddress } from '../server/base58.js';
import { BASE_FEE, EXPIRY_MARGIN, ChainError, SolanaChain, generateKeypair, parseSecretKey, priorityFee, shortvec, signMessage, transferMessage, serializeTransaction } from '../server/solana.js';

const hex = (s) => Buffer.from(s, 'hex');

test('base58 matches known addresses', () => {
  assert.deepEqual(b58decode('11111111111111111111111111111111'), Buffer.alloc(32));
  assert.deepEqual(b58decode('So11111111111111111111111111111111111111112'), hex('069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001'));
  assert.deepEqual(b58decode('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), hex('06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9'));
  assert.equal(b58encode(Buffer.from('Hello World!')), '2NEpo7TZRRrLZSi2U');
  assert.equal(b58encode(hex('00010966776006953D5567439E5E39F86A0D273BEED61967F6')), '16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM');
  for (let i = 0; i < 200; i++) {
    const bytes = crypto.randomBytes(1 + (i % 64));
    if (i % 5 === 0) bytes[0] = 0;
    assert.deepEqual(b58decode(b58encode(bytes)), bytes);
  }
  assert.ok(isAddress('So11111111111111111111111111111111111111112'));
  for (const bad of ['', 'hello', '0x52908400098527886E0F7030069857D2E4169EE7', 'So1111111111111111111111111111111111111111O', 42, null]) assert.equal(isAddress(bad), false);
  assert.throws(() => b58decode('0OIl'));
});

test('secret keys are read in the formats wallets export', () => {
  const kp = generateKeypair();
  const full = Buffer.concat([kp.seed, kp.publicKey]);
  assert.deepEqual(parseSecretKey(kp.secretKey).publicKey, kp.publicKey);
  assert.deepEqual(parseSecretKey(JSON.stringify([...full])).publicKey, kp.publicKey);
  assert.deepEqual(parseSecretKey(b58encode(kp.seed)).publicKey, kp.publicKey);
  const wrong = Buffer.from(full);
  wrong[40] ^= 1;
  assert.throws(() => parseSecretKey(b58encode(wrong)), /does not match/);
  assert.throws(() => parseSecretKey(''), /empty/);
  assert.throws(() => parseSecretKey(b58encode(crypto.randomBytes(20))), /expected 64 or 32 bytes/);
});

test('a transfer is encoded the way the network expects', () => {
  assert.deepEqual([0, 1, 127, 128, 300, 16384].map((n) => shortvec(n).toString('hex')), ['00', '01', '7f', '8001', 'ac02', '808001']);
  const from = generateKeypair();
  const to = generateKeypair();
  const blockhash = b58encode(crypto.randomBytes(32));
  const message = transferMessage({ from: from.publicKey, to: to.publicKey, lamports: 50_000_000, blockhash });
  // header, 3 keys, blockhash, one instruction
  assert.equal(message.length, 3 + 1 + 96 + 32 + 1 + 17);
  assert.deepEqual([...message.subarray(0, 4)], [1, 0, 1, 3]);
  assert.deepEqual(message.subarray(4, 36), from.publicKey);
  assert.deepEqual(message.subarray(36, 68), to.publicKey);
  assert.deepEqual(message.subarray(68, 100), Buffer.alloc(32));
  assert.deepEqual(message.subarray(100, 132), b58decode(blockhash));
  assert.equal(message.subarray(132).toString('hex'), '01' + '02' + '02' + '0001' + '0c' + '02000000' + '80f0fa0200000000');
  const signature = signMessage(message, from.seed);
  const spki = Buffer.concat([hex('302a300506032b6570032100'), from.publicKey]);
  assert.ok(crypto.verify(null, message, crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature));
  const tx = serializeTransaction(signature, message);
  assert.equal(tx.length, 215);
  assert.equal(tx[0], 1);
  // with a priority fee: the compute budget program and two more instructions
  const priced = transferMessage({ from: from.publicKey, to: to.publicKey, lamports: 1, blockhash, cuPrice: 20_000 });
  assert.deepEqual([...priced.subarray(0, 4)], [1, 0, 2, 4]);
  assert.deepEqual(priced.subarray(100, 132), b58decode('ComputeBudget111111111111111111111111111111'));
  assert.equal(priced.subarray(164).toString('hex'), '03' + '03000502d0070000' + '03000903204e000000000000' + '020200010c02000000' + '0100000000000000');
  assert.equal(priorityFee(20_000), 40);
  assert.throws(() => transferMessage({ from: from.publicKey, to: from.publicKey, lamports: 1, blockhash }), /same/);
  assert.throws(() => transferMessage({ from: from.publicKey, to: to.publicKey, lamports: 0, blockhash }), /amount/);
  assert.throws(() => transferMessage({ from: from.publicKey, to: to.publicKey, lamports: 1.5, blockhash }), /amount/);
});

/** A pretend RPC node, so the send-and-confirm logic can be tested without the network. */
function fakeRpc(script) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    calls.push({ method, params });
    let out = await script(method, params, calls);
    if (out === undefined && method === 'simulateTransaction') out = { value: { err: null } }; // the rehearsal passes unless a test says otherwise
    if (out && out.httpStatus) return { ok: false, status: out.httpStatus, json: async () => ({}) };
    if (out && out.throw) throw new Error(out.throw);
    return { ok: true, status: 200, json: async () => (out && out.error ? { jsonrpc: '2.0', id, error: out.error } : { jsonrpc: '2.0', id, result: out }) };
  };
  return { fetchImpl, calls };
}
const chainWith = (script, extra = {}) => {
  const rpc = fakeRpc(script);
  const chain = new SolanaChain({ rpcUrl: 'http://rpc.test', secret: generateKeypair().secretKey, fetchImpl: rpc.fetchImpl, pollMs: 5, timeoutMs: 400, ...extra });
  return { chain, calls: rpc.calls };
};
const blockhash = () => ({ value: { blockhash: b58encode(crypto.randomBytes(32)), lastValidBlockHeight: 1000 } });

test('a payout is sent, confirmed and reported with its signature', async () => {
  let polls = 0;
  const { chain, calls } = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return 'ignored';
    if (method === 'getSignatureStatuses') return { value: [++polls < 3 ? null : { confirmationStatus: 'confirmed', err: null }] };
    if (method === 'getBlockHeight') return 900;
  }, { priorityMicroLamports: 20_000 });
  const to = generateKeypair().address;
  let early;
  const { signature } = await chain.transfer(to, 50_000_000, { onSent: (info) => (early = info) });
  assert.equal(early.signature, signature);
  assert.equal(early.lastValidBlockHeight, 1000);
  const sent = calls.find((c) => c.method === 'sendTransaction');
  const raw = Buffer.from(sent.params[0], 'base64');
  assert.equal(sent.params[1].encoding, 'base64');
  assert.equal(b58encode(raw.subarray(1, 65)), signature, 'the signature we report is the one in the transaction');
  assert.deepEqual(raw.subarray(69, 101), b58decode(chain.address));
  assert.deepEqual(raw.subarray(101, 133), b58decode(to));
  assert.equal(chain.feeFor(), BASE_FEE + 40);
});

test('a refused payout is reported as nothing moved', async () => {
  const { chain } = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return { error: { code: -32002, message: 'Transaction simulation failed: insufficient lamports' } };
  });
  await assert.rejects(chain.transfer(generateKeypair().address, 1000), (e) => e instanceof ChainError && e.uncertain === false && /rejected/.test(e.message));
  const down = chainWith(() => ({ throw: 'connect ECONNREFUSED' }));
  await assert.rejects(down.chain.transfer(generateKeypair().address, 1000), (e) => e.uncertain === false && e.code === 'no_blockhash');
  await assert.rejects(chain.transfer('not-an-address', 1000), (e) => e.code === 'bad_address');
});

test('an expired payout is safe to retry, an on-chain failure is final, silence is uncertain', async () => {
  const expired = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return 'sig';
    if (method === 'getSignatureStatuses') return { value: [null] };
    if (method === 'getBlockHeight') return 1001 + EXPIRY_MARGIN;
  });
  await assert.rejects(expired.chain.transfer(generateKeypair().address, 1000), (e) => e.code === 'expired' && e.uncertain === false);

  // just past the deadline is not proof yet: the node answering may be a few blocks behind
  const barely = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return 'sig';
    if (method === 'getSignatureStatuses') return { value: [null] };
    if (method === 'getBlockHeight') return 1001;
  });
  await assert.rejects(barely.chain.transfer(generateKeypair().address, 1000), (e) => e.uncertain === true);
  assert.equal(barely.calls.filter((c) => c.method === 'sendTransaction').length, 1, 'and it is not sent again once its window has closed');

  // seen by the network but never confirmed: still not ours to call
  const limbo = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return 'sig';
    if (method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'processed', err: null }] };
    if (method === 'getBlockHeight') return 2000;
  });
  await assert.rejects(limbo.chain.transfer(generateKeypair().address, 1000), (e) => e.uncertain === true);

  const failed = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return 'sig';
    if (method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }] };
    if (method === 'getBlockHeight') return 900;
  });
  await assert.rejects(failed.chain.transfer(generateKeypair().address, 1000), (e) => e.code === 'tx_error' && e.uncertain === false);

  // a failure seen only on an unconfirmed fork is not final: on the fork that wins, the transfer may succeed
  const forked = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return 'sig';
    if (method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'processed', err: { InstructionError: [0, 'Custom'] } }] };
    if (method === 'getBlockHeight') return 900;
  });
  await assert.rejects(forked.chain.transfer(generateKeypair().address, 1000), (e) => e.uncertain === true);

  // the node stops answering after the send: we must not claim it failed
  let sent = false;
  const silent = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') {
      sent = true;
      return { httpStatus: 502 };
    }
    return sent ? { httpStatus: 502 } : undefined;
  });
  await assert.rejects(silent.chain.transfer(generateKeypair().address, 1000), (e) => e.uncertain === true);

  // landed even though the first send got no answer
  let n = 0;
  const flaky = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return { httpStatus: 429 };
    if (method === 'getSignatureStatuses') return { value: [++n < 2 ? null : { confirmationStatus: 'finalized', err: null }] };
    if (method === 'getBlockHeight') return 900;
  });
  assert.ok((await flaky.chain.transfer(generateKeypair().address, 1000)).signature);

  // "already processed" on the send means a copy got through: wait for it instead of calling it refused
  let m = 0;
  const twice = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return { error: { code: -32002, message: 'Transaction simulation failed: This transaction has already been processed' } };
    if (method === 'getSignatureStatuses') return { value: [++m < 2 ? null : { confirmationStatus: 'confirmed', err: null }] };
    if (method === 'getBlockHeight') return 900;
  });
  assert.ok((await twice.chain.transfer(generateKeypair().address, 1000)).signature);
});

test('token balances add up across accounts, and the self-check moves nothing', async () => {
  const { chain, calls } = chainWith((method, params) => {
    if (method === 'getTokenAccountsByOwner') {
      assert.deepEqual(params[1], { mint: 'MINT' });
      return { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: '1000000.5', uiAmount: 1000000.5 } } } } } }, { account: { data: { parsed: { info: { tokenAmount: { uiAmountString: '250000', uiAmount: 250000 } } } } } }] };
    }
    if (method === 'getBalance') return { value: 7_000_000_000 };
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'simulateTransaction') return { value: { err: null } };
    if (method === 'getSignatureStatuses') return { value: [null] };
  });
  assert.equal(await chain.tokenBalance('OWNER', 'MINT'), 1250000.5);
  assert.deepEqual(await chain.selfCheck(), { address: chain.address, balance: 7_000_000_000, simulation: 'ok', history: true });
  assert.ok(!calls.some((c) => c.method === 'sendTransaction'));
  // a provider that cannot look up past transactions is called out, because settling an interrupted payout needs it
  const forgetful = chainWith((method) => {
    if (method === 'getBalance') return { value: 1 };
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'simulateTransaction') return { value: { err: null } };
    if (method === 'getSignatureStatuses') return { error: { code: -32011, message: 'Transaction history is not available from this node' } };
  });
  assert.equal((await forgetful.chain.selfCheck()).history, false);
  const empty = chainWith(() => ({ value: [] }));
  assert.equal(await empty.chain.tokenBalance('OWNER', 'MINT'), 0);
});

test('an answer we cannot read, or an error we do not know, is never taken as "nothing was sent"', async () => {
  // the node accepted the transaction but its answer was cut off / was not JSON / was empty
  for (const broken of [{ json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')) }, { json: async () => null }, { json: async () => 'ok' }, { json: async () => [] }]) {
    let polls = 0;
    const fetchImpl = async (_url, init) => {
      const { method, id } = JSON.parse(init.body);
      const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id, result }) });
      if (method === 'getLatestBlockhash') return reply(blockhash());
      if (method === 'simulateTransaction') return reply({ value: { err: null } });
      if (method === 'sendTransaction') return { ok: true, status: 200, ...broken };
      if (method === 'getSignatureStatuses') return reply({ value: [++polls < 2 ? null : { confirmationStatus: 'confirmed', err: null }] });
      if (method === 'getBlockHeight') return reply(900);
    };
    const chain = new SolanaChain({ rpcUrl: 'http://rpc.test', secret: generateKeypair().secretKey, fetchImpl, pollMs: 5, timeoutMs: 400 });
    assert.ok((await chain.transfer(generateKeypair().address, 1000)).signature, 'it landed, and we noticed');
  }
  // same broken answer, and it never shows up: we still may not call it refused
  const lost = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return { error: { code: -32603, message: 'Internal error' } };
    if (method === 'getSignatureStatuses') return { value: [null] };
    if (method === 'getBlockHeight') return 900;
  });
  await assert.rejects(lost.chain.transfer(generateKeypair().address, 1000), (e) => e.uncertain === true);
  for (const code of [429, -32429, undefined, 'limit']) {
    const odd = chainWith((method) => {
      if (method === 'getLatestBlockhash') return blockhash();
      if (method === 'sendTransaction') return { error: { code, message: 'slow down' } };
      if (method === 'getSignatureStatuses') return { value: [null] };
      if (method === 'getBlockHeight') return 900;
    });
    await assert.rejects(odd.chain.transfer(generateKeypair().address, 1000), (e) => e.uncertain === true, `code ${code}`);
  }
  // the refusals a node makes before passing a transaction on are still plain refusals
  for (const code of [-32002, -32003, -32013, -32602]) {
    const refused = chainWith((method) => {
      if (method === 'getLatestBlockhash') return blockhash();
      if (method === 'sendTransaction') return { error: { code, message: 'no' } };
    });
    await assert.rejects(refused.chain.transfer(generateKeypair().address, 1000), (e) => e.uncertain === false && /rejected/.test(e.message), `code ${code}`);
    assert.equal(refused.calls.filter((c) => c.method === 'getSignatureStatuses').length, 0);
  }
  // a status answer that makes no sense counts as "cannot tell", not as "never heard of it"
  const garbled = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return 'sig';
    if (method === 'getSignatureStatuses') return { value: 'what' };
    if (method === 'getBlockHeight') return 5000;
  });
  await assert.rejects(garbled.chain.transfer(generateKeypair().address, 1000), (e) => e.uncertain === true);
});

test('two payouts of the same amount to the same wallet are two different transactions', async () => {
  const frozen = blockhash();
  let asked = 0;
  const { chain, calls } = chainWith((method) => {
    if (method === 'getLatestBlockhash') return ++asked <= 3 ? frozen : blockhash(); // the node keeps handing out the same blockhash for a while
    if (method === 'sendTransaction') return 'sig';
    if (method === 'getSignatureStatuses') return { value: [{ confirmationStatus: 'confirmed', err: null }] };
    if (method === 'getBlockHeight') return 900;
  });
  const to = generateKeypair().address;
  const [a, b] = await Promise.all([chain.transfer(to, 50_000_000), chain.transfer(to, 50_000_000)]);
  assert.notEqual(a.signature, b.signature);
  const sent = new Set(calls.filter((c) => c.method === 'sendTransaction').map((c) => c.params[0]));
  assert.equal(sent.size, 2, 'two distinct transactions reached the node');
  assert.ok(asked >= 4, 'the second one waited for a new blockhash');
  // a different amount or a different wallet is already a different transaction: no waiting
  asked = 0;
  await Promise.all([chain.transfer(to, 60_000_000), chain.transfer(generateKeypair().address, 60_000_000)]);
  assert.equal(asked, 2);
});

test('a balance answer that makes no sense is an error, never a number', async () => {
  for (const value of [undefined, null, 'lots', -5, 1.5, NaN, 2 ** 60]) {
    const { chain } = chainWith((method) => (method === 'getBalance' ? { context: { slot: 9 }, value } : null));
    await assert.rejects(chain.getBalance(), /makes no sense/, String(value));
  }
  const fine = chainWith((method) => (method === 'getBalance' ? { context: { slot: 9 }, value: 12345 } : null));
  assert.deepEqual(await fine.chain.balanceAt(), { lamports: 12345, slot: 9 });
});

test('a node that is a step behind is given another go instead of failing the hunter', async () => {
  for (const first of [{ code: -32002, message: 'Transaction simulation failed: Blockhash not found' }, { code: -32005, message: 'Node is behind by 42 slots' }, { code: -32016, message: 'Minimum context slot has not been reached' }]) {
    let sends = 0;
    let polls = 0;
    const { chain } = chainWith((method) => {
      if (method === 'getLatestBlockhash') return blockhash();
      if (method === 'sendTransaction') return ++sends === 1 ? { error: first } : 'sig';
      if (method === 'getSignatureStatuses') return { value: [sends >= 2 && ++polls >= 2 ? { slot: 77, confirmationStatus: 'confirmed', err: null } : null] };
      if (method === 'getBlockHeight') return 900;
    }, { pollMs: 2, resendMs: 5, timeoutMs: 3000 });
    const out = await chain.transfer(generateKeypair().address, 1000);
    assert.equal(out.slot, 77, 'and the slot it landed in is reported');
    assert.ok(sends >= 2, first.message);
  }
});

test('answers the payout code depends on are checked before they are believed', async () => {
  for (const value of [undefined, null, {}, { blockhash: 'x' }, { blockhash: b58encode(crypto.randomBytes(32)) }, { blockhash: b58encode(crypto.randomBytes(32)), lastValidBlockHeight: 'soon' }, { blockhash: 5, lastValidBlockHeight: 10 }]) {
    const { chain, calls } = chainWith((method) => (method === 'getLatestBlockhash' ? { value } : 'sig'));
    await assert.rejects(chain.transfer(generateKeypair().address, 1000), (e) => e.code === 'no_blockhash' && e.uncertain === false, JSON.stringify(value));
    assert.ok(!calls.some((c) => c.method === 'sendTransaction'), 'nothing is sent without a known expiry');
  }
  const { chain } = chainWith((method, params) => (method === 'getSignatureStatuses' ? { value: params[0].map((s, i) => (i === 1 ? { slot: 5, confirmationStatus: 'finalized', err: null } : i === 2 ? 'junk' : null)) } : null));
  assert.deepEqual(await chain.signatureStatuses(['a', 'b', 'c']), [null, { slot: 5, confirmationStatus: 'finalized', err: null }, null]);
  assert.deepEqual(await chain.signatureStatuses([]), []);
  const short = chainWith((method) => (method === 'getSignatureStatuses' ? { value: [null] } : null));
  await assert.rejects(short.chain.signatureStatuses(['a', 'b']), /makes no sense/);
});

test('every payout is rehearsed first, so a doomed one never gets as far as being recorded or sent', async () => {
  // the node says the transaction cannot work (here: the recipient is a program)
  let recorded = 0;
  const doomed = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'simulateTransaction') return { value: { err: 'AccountLoadedTwice' } };
  });
  await assert.rejects(doomed.chain.transfer(generateKeypair().address, 1000, { onSent: () => recorded++ }), (e) => e.code === 'rehearsal' && e.uncertain === false && /AccountLoadedTwice/.test(e.message));
  assert.equal(recorded, 0, 'the signature was never put on record');
  assert.ok(!doomed.calls.some((c) => c.method === 'sendTransaction'), 'and nothing was sent');
  // an error object instead of a string, as the network reports most failures
  const poor = chainWith((method) => (method === 'getLatestBlockhash' ? blockhash() : method === 'simulateTransaction' ? { value: { err: { InstructionError: [2, { Custom: 1 }] } } } : undefined));
  await assert.rejects(poor.chain.transfer(generateKeypair().address, 1000), (e) => e.code === 'rehearsal' && /Custom/.test(e.message));
  // the node cannot be asked: nothing was sent either
  const mute = chainWith((method) => (method === 'getLatestBlockhash' ? blockhash() : method === 'simulateTransaction' ? { httpStatus: 503 } : undefined));
  await assert.rejects(mute.chain.transfer(generateKeypair().address, 1000), (e) => e.code === 'no_blockhash' && e.uncertain === false);
  assert.ok(!mute.calls.some((c) => c.method === 'sendTransaction'));
  // a node that has not caught up with the blockhash yet is asked again, and then the payout goes ahead
  let tries = 0;
  const behind = chainWith((method) => {
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'simulateTransaction') return { value: { err: ++tries < 3 ? 'BlockhashNotFound' : null } };
    if (method === 'sendTransaction') return 'sig';
    if (method === 'getSignatureStatuses') return { value: [{ slot: 9, confirmationStatus: 'confirmed', err: null }] };
    if (method === 'getBlockHeight') return 900;
  });
  assert.ok((await behind.chain.transfer(generateKeypair().address, 1000)).signature);
  assert.equal(tries, 3);
  // the order of things: rehearse, record, send
  const order = [];
  const tidy = chainWith((method) => {
    if (method !== 'getBlockHeight') order.push(method);
    if (method === 'getLatestBlockhash') return blockhash();
    if (method === 'sendTransaction') return 'sig';
    if (method === 'getSignatureStatuses') return { value: [{ slot: 9, confirmationStatus: 'confirmed', err: null }] };
    if (method === 'getBlockHeight') return 900;
  });
  await tidy.chain.transfer(generateKeypair().address, 1000, { onSent: () => order.push('recorded') });
  assert.deepEqual(order.slice(0, 4), ['getLatestBlockhash', 'simulateTransaction', 'recorded', 'sendTransaction']);
});

test('telling a wallet from a coin, a token account or a program', async () => {
  const answers = {
    fresh: { value: null },
    wallet: { value: { executable: false, owner: '11111111111111111111111111111111', lamports: 5 } },
    token: { value: { executable: false, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 5 } },
    token22: { value: { executable: false, owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', lamports: 5 } },
    program: { value: { executable: true, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', lamports: 5 } },
    owned: { value: { executable: false, owner: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', lamports: 5 } },
  };
  const { chain } = chainWith((method, params) => (method === 'getAccountInfo' ? answers[params[0]] : undefined));
  assert.deepEqual(await Promise.all(Object.keys(answers).map((a) => chain.accountKind(a))), ['wallet', 'wallet', 'token', 'token', 'program', 'other']);
  for (const junk of [undefined, null, 'x', {}, { value: 5 }, { value: {} }]) {
    const odd = chainWith((method) => (method === 'getAccountInfo' ? junk : undefined));
    await assert.rejects(odd.chain.accountKind('a'), /makes no sense/, JSON.stringify(junk));
  }
});
