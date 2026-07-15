import { getNetworkInfo, Network } from "@injectivelabs/networks";
import {
  MsgExecuteContract,
  DEFAULT_STD_FEE,
  privateKeyToPublicKeyBase64,
  ChainRestAuthApi,
} from "@injectivelabs/sdk-ts";
import { PrivateKey } from "@injectivelabs/sdk-ts/dist/local";
import { createTransaction, TxGrpcClient } from "@injectivelabs/tx-ts";
import { fromUint8Array } from "js-base64";
import { impossible, Payload } from "./vaa";
import { NETWORKS } from "./networks";
import { CONTRACTS } from "@certusone/wormhole-sdk";

export async function execute_injective(
  payload: Payload,
  vaa: Buffer,
  environment: "MAINNET" | "TESTNET" | "DEVNET",
  contractAddress?: string
) {
  if (environment === "DEVNET") {
    throw new Error("Injective is not supported in DEVNET");
  }
  const chainName = "injective";
  let n = NETWORKS[environment][chainName];
  if (!n.key) {
    throw Error(`No ${environment} key defined for Injective`);
  }
  let contracts = CONTRACTS[environment][chainName];
  const endPoint =
    environment === "MAINNET" ? Network.MainnetK8s : Network.TestnetK8s;

  const network = getNetworkInfo(endPoint);
  const walletPKHash = n.key;
  const walletPK = PrivateKey.fromPrivateKey(walletPKHash);
  const walletInjAddr = walletPK.toBech32();
  const walletPublicKey = privateKeyToPublicKeyBase64(
    Buffer.from(walletPKHash, "hex")
  );

  let target_contract: string | undefined;
  let execute_msg: Record<string, object>;

  switch (payload.module) {
    case "Core":
      target_contract = contractAddress ?? contracts.core;
      if (target_contract === undefined) {
        throw new Error(
          `No ${environment} Core contract defined for Injective; pass --contract-address to override`
        );
      }
      execute_msg = {
        submit_v_a_a: {
          vaa: fromUint8Array(vaa),
        },
      };
      switch (payload.type) {
        case "GuardianSetUpgrade":
          console.log("Submitting new guardian set");
          break;
        case "ContractUpgrade":
          console.log("Upgrading core contract");
          break;
        default:
          impossible(payload);
      }
      break;
    case "NFTBridge":
      target_contract = contractAddress ?? contracts.nft_bridge;
      if (target_contract === undefined) {
        // NOTE: this code can safely be removed once the injective NFT bridge is
        // released, but it's fine for it to stay, as the condition will just be
        // skipped once 'contracts.nft_bridge' is defined
        throw new Error(
          `No ${environment} NFT bridge contract defined for Injective; pass --contract-address to override`
        );
      }
      execute_msg = {
        submit_vaa: {
          data: fromUint8Array(vaa),
        },
      };
      switch (payload.type) {
        case "ContractUpgrade":
          console.log("Upgrading contract");
          break;
        case "RegisterChain":
          console.log("Registering chain");
          break;
        case "Transfer":
          console.log("Completing transfer");
          break;
        default:
          impossible(payload);
      }
      break;
    case "TokenBridge":
      target_contract = contractAddress ?? contracts.token_bridge;
      if (target_contract === undefined) {
        throw new Error(
          `No ${environment} TokenBridge contract defined for Injective; pass --contract-address to override`
        );
      }
      execute_msg = {
        submit_vaa: {
          data: fromUint8Array(vaa),
        },
      };
      switch (payload.type) {
        case "ContractUpgrade":
          console.log("Upgrading contract");
          break;
        case "RegisterChain":
          console.log("Registering chain");
          break;
        case "Transfer":
          console.log("Completing transfer");
          break;
        case "AttestMeta":
          console.log("Creating wrapped token");
          break;
        case "TransferWithPayload":
          throw Error("Can't complete payload 3 transfer from CLI");
        default:
          impossible(payload);
          break;
      }
      break;
    default:
      target_contract = impossible(payload);
      execute_msg = impossible(payload);
  }

  const [[action, msg]] = Object.entries(execute_msg);
  console.log("execute_msg", execute_msg);
  const transaction = MsgExecuteContract.fromJSON({
    sender: walletInjAddr,
    contractAddress: target_contract,
    msg,
    action,
  });
  console.log("transaction:", transaction);

  const accountDetails = await new ChainRestAuthApi(
    network.sentryHttpApi
  ).fetchAccount(walletInjAddr);
  const { signBytes, txRaw } = createTransaction({
    message: transaction.toDirectSign(),
    memo: "",
    fee: DEFAULT_STD_FEE,
    pubKey: walletPublicKey,
    sequence: parseInt(accountDetails.account.base_account.sequence, 10),
    accountNumber: parseInt(
      accountDetails.account.base_account.account_number,
      10
    ),
    chainId: network.chainId,
  });
  console.log("txRaw", txRaw);

  console.log("sign transaction...");
  /** Sign transaction */
  const sig = await walletPK.sign(Buffer.from(signBytes));

  /** Append Signatures */
  txRaw.setSignaturesList([sig]);

  const txService = new TxGrpcClient({
    txRaw,
    endpoint: network.sentryGrpcApi,
  });

  console.log("simulate transaction...");
  /** Simulate transaction */
  try {
    const simulationResponse = await txService.simulate();
    console.log(
      `Transaction simulation response: ${JSON.stringify(
        simulationResponse.gasInfo
      )}`
    );
  } catch (e) {
    console.log("Failed to simulate:", e);
    return;
  }

  console.log("broadcast transaction...");
  /** Broadcast transaction */
  const txResponse = await txService.broadcast();
  console.log("txResponse", txResponse);

  if (txResponse.code !== 0) {
    console.log(`Transaction failed: ${txResponse.rawLog}`);
  } else {
    console.log(
      `Broadcasted transaction hash: ${JSON.stringify(txResponse.txhash)}`
    );
  }
}
