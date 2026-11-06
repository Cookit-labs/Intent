# Kamino Limo limit orders on Solana: feasibility report (2026-11-05)

Method: downloaded and read `@kamino-finance/limo-sdk@4.0.0` source from npm (tarball unpacked in scratchpad/pkg), read the program source at github.com/Kamino-Finance/limo (master), and queried mainnet read-only (api.mainnet-beta.solana.com). Nothing was signed or sent.

## 1. SDK

- Package: `@kamino-finance/limo-sdk`, latest 4.0.0 (published 2026-10-05; 3.1.0 on 2026-07-30). Apache-2.0. Repo: github.com/Kamino-Finance/limo-sdk (the package.json points at Kamino-Finance/limo/tree/master/limo-sdk; the standalone limo-sdk repo has src/, README, package.json).
- Built on `@solana/kit` (Codama-generated client since 3.0.0). Dependencies: `@solana/kit` pinned EXACT `8.3.0` (our app has ^8.6.0, so expect a second nested kit copy and possible type clashes at the boundary), `@solana-program/{token,token-2022,system,compute-budget}`, `@coral-xyz/anchor ^0.28.0` and `@coral-xyz/borsh` (used only for `BN`; anchor 0.28 drags in `@solana/web3.js` v1 transitively), `decimal.js`, `bn.js`, `bs58`, plus `commander` and `dotenv` (CLI only, in `client.ts`, not exported from index). `index.ts` is just `export * from "./Limo"`.
- Server-safe: yes in practice. No fs/net code in the exported path; only `process.env.LIMO_PROGRAM_ID` is read (utils/programId.ts), which overrides the program id if set. Do not leave that env var set in prod; the assert-safe program allow-list would catch a wrong program anyway. It is heavy (anchor + web3.js v1 in the bundle). Lighter alternative: skip the SDK and hand-build the three instructions with kit (Codama code is small, discriminators below).
- Client: `new LimoClient(rpc: Rpc<SolanaRpcApi>, subscription: RpcSubscriptions<SolanaRpcSubscriptionsApi>, globalConfig: Address | undefined, globalConfigState?, programId?)`. It needs an RpcSubscriptions object even for tx building (only used by listeners / `processTxn`). The README snippet is stale (two args).
- Mainnet program: `LiMoM9rMhrdYrfzUCxQppvxCSG1FcrUK9G8uLq4A1GF`. Mainnet global config (found on chain, see section 4): `prod7Mog8r56sn5dPwze8nVdf94veEawdxNNqd5v7A1` (pda_authority `DJGVEH2F5DdwQVNgxtCEVSpC2Qu5sEjRmBHfa22tAnYY`, matches an Orb label "Kamino Swap Limit Orders Vault Authority"). The SDK does not hard-code it; the caller must pass it. No docs page states it (verified: kamino.com docs give no addresses).
- Create (returns instructions, no sending):
  - `createOrderGenericIx(user: TransactionSigner, inputMint: Address, outputMint: Address, inputAmountLamports: BN, outputAmountLamports: BN, inputMintProgramId: Address, outputMintProgramId: Address, globalConfigOverride?: Address, wrapUnwrapSol = true, withInitVault?: boolean): Promise<[Instruction[], TransactionSigner]>` (second value is a fresh order keypair that must co-sign).
  - `createOrderGenericWithParamsIx(args: CreateOrderWithParamsArgs)` adds optional `permissionless` and `counterparty` update_order instructions.
  - `placeBidIxs(user, quoteTokenMint, baseTokenMint, baseUiAmount: Decimal, price: Decimal, inputMintProgramId, outputMintProgramId, mintDecimals?, globalConfigOverride?)`; also `placeAskIxs`. Note: placeBid computes output as `baseUiAmount.div(price)`, a price convention we should not rely on; compute input and output raw amounts ourselves.
  - Sending versions (`createOrderGeneric`, `placeBid`, ...) call `processTxn(user, ixs, mode, ...)`, which needs a keypair signer; not usable for a non-custodial flow. Use the `*Ix` variants and build the message ourselves.
- Cancel: `closeOrderAndClaimTipIx(maker: TransactionSigner, order: OrderStateAndAddress, wrapUnwrapSol = true): Promise<Instruction[]>`. The same instruction cancels an open order and closes a filled one. There is no separate cancel.
- Read:
  - `getOrderState(orderAddress): Promise<Order>`
  - `getAllOrdersStateAndAddressForMaker(maker: Address): Promise<OrderStateAndAddress[]>` (uses getProgramAccounts with memcmp on discriminator, global config and maker)
  - `getAllOrdersDisplayForMaker(maker)`, `getOrderDisplay(address)`, `getAllOrdersDisplayForMakerInputAndOutputMints(...)`, `getLatestFilledOrders(...)`.
  - Fill state is in the `Order` account: `initialInputAmount`, `remainingInputAmount`, `expectedOutputAmount`, `filledOutputAmount`, `tipAmount`, `numberOfFills`, `status` (0 Active, 1 Filled, 2 Cancelled), `permissionless`, `counterparty`, `lastUpdatedTimestamp`. Order account is 424 bytes, discriminator `134,173,223,185,77,86,28,51`. getProgramAccounts on a public RPC is heavy (22.7k order accounts for the prod config); in production filter by maker (memcmp offset 40) with a paid RPC, or fetch known order addresses with getMultipleAccounts.
- Instruction discriminators (Anchor): create_order `141,54,37,207,237,210,250,215`; close_order_and_claim_tip `244,27,12,226,45,247,230,43`; update_order `54,8,208,207,34,134,239,168`. create_order data: disc(8) + input_amount u64 + output_amount u64 + order_type u8 (0 = bid).

## 2. Transactions and what assert-safe must verify

### Create (SDK order, wSOL input shown; `wrapUnwrapSol` true by default)

1. (only if the vault for the input mint does not exist) Limo `initialize_vault` (payer = user, creates the escrow vault token account, PDA seeds `["escrow_vault", globalConfig, mint]`). User pays that rent; not refundable (the vault is shared). Common mints already have vaults.
2. System `create_account`: payer user, new account = order keypair (co-signer), 424 bytes, 3,841,920 lamports (0.00384 SOL), owner = Limo program.
3. If input is SOL: ATA program `create_idempotent` for the user's wSOL ATA, System `transfer` of exactly the input amount user -> wSOL ATA, Token `sync_native` (data `[17]`).
4. Limo `create_order(input_amount, output_amount, order_type)`. Accounts: maker (signer, writable), global_config (writable), pda_authority, order, input_mint, output_mint, maker_ata (user's input ATA), input_vault (PDA), input token program, output token program, system program, event authority, program. On chain it transfers `input_amount` from maker_ata to the vault and transfers `ata_creation_cost + txn_fee_cost` lamports from the maker to the global config account (on prod: 3,000,000 + 0 = 0.003 SOL).
5. If input is SOL: Token `close_account` of the wSOL ATA, destination = user (unwraps any leftover; note this also unwraps any pre-existing wSOL balance in that ATA).
6. Optional: Limo `update_order` (mode 0 permissionless = true, mode 1 counterparty).

- Rent / who pays back: order account rent (0.00384 SOL) returns to the maker when the order is closed (`close = maker`). The 0.003 SOL "txn fee cost" goes to the global config account. In the public program source (last commit 2025-11-26) it is NOT refunded at close; the SDK 4.0.0 `Order` struct has a newer `feePaid` field described as "refunded to the maker via close = maker", and the deployed program is newer than the public source (redeployed 2026-09-11), so whether it is refunded is UNVERIFIED. Budget for losing 0.003 SOL.
- Correction, from simulation on 2026-11-05 (`solana-limo.live.test.ts`, read and simulate only): the 0.003 SOL is returned on close. A simulated create left the order account at 6,841,920 lamports (rent plus the fee) and the global config's balance unchanged, so on the deployed binary the fee sits on the order account, as the SDK's `feePaid` says, not in the config as step 4 above and sections 3 and 5 below say. A simulated close of a real filled order holding 6,841,920 lamports paid the maker 6,816,920, which is all of it less the 25,000 lamport network and priority fee. Not yet seen on a landed transaction.
- Gap to handle: the SDK does not create the maker's OUTPUT token account. When the output is not wSOL the filler needs the maker's output ATA to exist (take_order's `maker_output_ata` is checked with `verify_ata`). Prod `ata_creation_cost` is 0, so the program does not subsidise it. Add an ATA-program `create_idempotent` for the output mint (owner = user) to our create tx, or fills for that order can fail. (Reasoned from source; not tested.) When the output is SOL, fills pay native SOL straight to the maker (no ATA needed).

### Cancel / close

1. If SOL input: ATA `create_idempotent` wSOL ATA (owner user). Otherwise ATA `create_idempotent` for the input mint ATA (owner user).
2. Limo `close_order_and_claim_tip`. Accounts: maker (signer), order (writable, closed to maker), global_config, pda_authority, input_mint, output_mint, maker_input_ata, input_vault, input token program, system program, event authority, program. On chain: returns `remaining_input_amount` from the vault to maker_input_ata, pays `tip_amount` lamports from pda_authority to the maker, closes the order account and refunds its rent to the maker. Fails if `now < last_updated_timestamp + order_close_delay_seconds` (0 on prod now), if the order is in a flash operation, or if status is already Cancelled.
3. If SOL: Token `close_account` of the wSOL ATA to user (unwraps).

- For a filled order the maker's output has ALREADY been paid at fill time (to the maker's output ATA, or native SOL). Closing only returns leftover input, the tips, and rent. Filled orders stay as 424-byte accounts (22,375 of 22,739 prod order accounts are status Filled) until the maker closes them, so the app should offer "close" for filled orders to recover 0.00384 SOL plus tips.

### What the pre-sign decoder should verify (create)

Existing policy shape `programs: {id: {discriminators}}`, `mayWrapSol` fits. Additional checks needed because limo is not a token transfer the current code understands:

- Program allow-list: Limo `LiMoM9...`, System, Token (or Token-2022), ATA, ComputeBudget. Nothing else.
- Limo create_order: decode the data and require input_amount == requested raw amount, output_amount == requested raw output (price = output/input, check both), order_type == 0.
- Account checks on that instruction: maker == the signer/owner; global_config == `prod7Mog8...` (pin it; a different config means a different admin and filler set, and a hostile config could hold or block funds); pda_authority == PDA(["authority", globalConfig]); input_vault == PDA(["escrow_vault", globalConfig, inputMint]); maker_ata == the owner's ATA for inputMint; input_mint and output_mint == the requested mints; token programs match the mints' owners; order account == the key of the extra order signer and is the account created by the create_account instruction (space 424, owner Limo, lamports 3,841,920 +/- config, payer = user).
- Other instructions: System `transfer` only to the user's own wSOL ATA, amount <= input amount (the existing wrap check); no System transfer to any other address except the global-config fee transfer which happens inside the Limo CPI (so it will not appear as a top-level instruction; cap it by simulating, or by reading global_config `txn_fee_cost + ata_creation_cost` and bounding the user's SOL loss to input + rent + fee). Token `close_account` destination must be the user. ATA creates must have owner = user (or the user's own key). No Token `approve`, `set_authority`, or `transfer` to third parties.
- Optional update_order: allow only mode 0 with value 1 (permissionless) if we ever enable it; refuse mode 1 (counterparty) unless we set it intentionally.
- Order keypair: the tx has two signers (user + order key); the existing check that only the user must sign needs an exception for exactly one fresh ephemeral signer that is the new order account. The server must hold that key only for the signing step (or generate it client-side) and it holds no value.
- Verify the price: the dapp should decode and show input mint/amount, output mint/min amount, and the implied price from the two u64s, using mint decimals from chain.

### What to verify (cancel)

close_order_and_claim_tip: maker == user; order account is one the app read from chain with `maker == user` (fetch and compare; the program enforces has_one maker, so a wrong order simply fails); maker_input_ata is the user's own ATA (token::authority = maker is enforced on chain, but check anyway); pda_authority and vault PDAs as above; global_config pinned; no extra transfers.

## 3. Fill behaviour

- Fillers: the order is filled by "searchers" in an auction; the winner pays a SOL tip to the trader (docs, kamino.com/docs/products/swap/limit-orders). Kamino charges no platform fee. Mainnet global config: `host_fee_bps = 0` (verified on chain), so no protocol cut either; tip lamports sit in pda_authority and are paid to the maker on close.
- Third-party orders are filled only by the permissioned path unless the maker opts in: `take_order` requires `order.permissionless != 0` OR a valid Pyth Express Relay (PER) permission in the same tx (`check_permission_and_get_tip`). `create_order` sets `permissionless = 0` and `counterparty = default`. Verified via on-chain scan of the prod config: 22,726 of 22,739 orders have permissionless = 0 and 13 have it = 1. So normal orders created by anyone (any frontend, including ours) are eligible for PER searchers; there is no host/referrer allow-list in the program for makers, so third-party-created orders are treated the same as Kamino-UI ones. The program has no whitelist of maker or frontend. Whether PER searchers fill every pair or only the liquid ones is up to them (UNVERIFIED beyond the stats below).
- Partial fills: yes. `take_order(input_amount, min_output_amount, tip)`; the taker may fill any `input_amount <= remaining`, and must pay at least `ceil(input * expected_output / initial_input)` (pro rata, rounding up in the maker's favour). Never worse than the stated price.
- Expiry: none. The order account has no expiry field. It stays until filled or the maker cancels (docs say the same). Our UI must make that visible.
- Minimum size: none in the program (only input_amount > 0, output_amount > 0, different mints). Practically, searchers need the fill to beat tip + fees, so dust may never fill (UNVERIFIED).
- Fees paid by the maker: 0.003 SOL per order (txn_fee_cost) plus 0.00384 SOL refundable order rent plus signature/priority fee, plus a one-time vault rent if the input mint has no vault.
- Tips / global config: no tip required from the maker; the global config is needed as an account input (pin `prod7Mog8...`); the maker cannot pay a tip. Searchers pay the tip.
- Pairs observed on prod (open + filled-not-yet-closed order accounts, 22,739 total): USDC->SOL 7,814; SOL->USDC 6,780; USDC->USDT 1,394; USDT->USDC 1,172; USDT->SOL 693; USDC->cbBTC-like mint(cbbt...) 688; SOL->USDT 345; SOL->J1to(JitoSOL) 284. Status: 22,375 filled, 364 active. A 98% filled share of surviving accounts suggests these majors do fill; but filled orders linger while cancelled ones are deleted, so this is survivorship-biased and says nothing about price distance or time-to-fill. UNVERIFIED for long-tail pairs; we should restrict to SOL/USDC/USDT and a few majors.

## 4. On-chain facts (read-only RPC)

- Program `LiMoM9...` is deployed, executable, owner BPFLoaderUpgradeable. ProgramData `Eqay3PwNFLH7C2MSSsrZashRbzu2CBGCVMYr3zttM4sQ`, last deployed slot 446,205,635 = 2026-09-11 16:45 UTC (so the public GitHub source, last commit 2025-11-26, is behind the deployed binary).
- Upgrade authority: `E4NYRj51oRgZpVNJFhX8fF7KThy3ukwd57Tc31iQ8rCs` (system-owned, 0 data; same key is the global config `admin_authority`). It is upgradeable, so Kamino can change program logic at any time. Whether this is a Squads vault/multisig is UNVERIFIED (a system-owned PDA is consistent with a Squads vault but not proof).
- Global configs under the program: 6 (TeStcU..., prod7Mog8r56sn5dPwze8nVdf94veEawdxNNqd5v7A1, 3Lvo5g..., 98JtHV..., FVVFqi..., Fankws...). The `prod7Mog8...` one has emergency_mode 0, flash_take_blocked 0, new_orders_blocked 0, orders_taking_blocked 0, host_fee_bps 0, order_close_delay 0, txn_fee_cost 3,000,000, ata_creation_cost 0, total_tip_amount 95.2 SOL-equivalent lamports 95,206,476,055 and pda_authority balance 95.22 SOL. The admin can flip emergency mode or block new orders or order taking; funds stay in vaults (the admin has no instruction to sweep maker input from the vault: `withdraw_host_tip` only moves host tips).
- Recent activity: the latest 1,000 signatures span 2026-11-04 13:41 to 2026-11-05 12:03 UTC (about 40 txs/hour at minimum; 32 of 1,000 failed). Actively used.
- Audits (listed on kamino.com/docs/security/audits, web search snippet only; I did not open the report PDFs, so scope and findings UNVERIFIED): OtterSec 2024-11-07, Offside Labs 2024-11-29, Sec3 2025-01-29, Certora formal verification 2025-02-21 or 2025-05-13 (docs disagree). Bug bounty stated as $1.5M. These pre-date the current binary (Sept 2026 upgrade, newer fee_paid and RFQ venue code), so the deployed version is not fully covered by the dated audits as far as I can tell. Incidents: none found in a quick search; I did not do a deep incident search.

## 5. Verdict

Buildable, yes, non-custodial and kit-native. Estimated work: build the create/cancel/close instructions (SDK `*Ix` functions or a small hand-written kit builder), add an assert-safe policy for Limo, read orders by maker, UI for open/partially filled/filled-unclosed orders.

Main risks:

1. Funds sit in a Kamino PDA vault under an UPGRADEABLE program controlled by one non-program-verified key. A malicious or buggy upgrade could affect all escrowed input. Audits predate the latest binary.
2. No expiry and no guaranteed filler. Order stays open until the price is hit and a searcher wants it; the person must cancel to get funds back, and dust or off-market orders may never fill. Permissionless is off by default, so only Pyth Express Relay searchers can fill (verified from source and chain).
3. Cost: 0.003 SOL non-refundable (probably) per order, plus 0.00384 SOL rent refunded only after the user closes the order (including after fill), plus one-time vault rent for new input mints.
4. Missing output ATA (SDK does not create it): add an idempotent ATA create or fills can fail.
5. SDK hygiene: exact-pinned kit 8.3.0 vs our 8.6.0, anchor 0.28 and web3.js v1 pulled in, SDK README stale; the public program source is older than the deployed binary, so source reading is not a full guarantee of behaviour.
6. Wrong global config is the main injection vector: the SDK takes it as input; pin `prod7Mog8...` in assert-safe.

What a person can lose: the escrowed input amount in the worst case (program upgrade bug or exploit, or a pause that traps funds if admin disables closing; no close-blocking flag was seen in config, only new orders and order taking can be blocked); 0.003 SOL fee per order; an order filled at exactly their limit (no price improvement guaranteed, though the searcher tip adds a little SOL); and the rent of filled orders if they never close them. They cannot lose more than the escrowed input plus fee, because the tx is signed by the user and the output is paid pro rata at the stated price by program checks.

Sources: npm @kamino-finance/limo-sdk 4.0.0; https://github.com/Kamino-Finance/limo-sdk; https://github.com/Kamino-Finance/limo (programs/limo/src/handlers/create_order.rs, close_order_and_claim_tip.rs, take_order.rs, operations.rs); https://kamino.com/docs/products/swap/limit-orders; https://kamino.com/docs/security/audits; https://kamino.com/docs/security; https://kamino.com/docs/security/formal-verification; api.mainnet-beta.solana.com read-only queries.
