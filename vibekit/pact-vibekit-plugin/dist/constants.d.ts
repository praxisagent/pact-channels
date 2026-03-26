export declare const PACT_TOKEN = "0x809c2540358E2cF37050cCE41A610cb6CE66Abe1";
export declare const PACT_ESCROW_V2 = "0x220B97972d6028Acd70221890771E275e7734BFB";
export declare const PACT_PAYMENT_CHANNEL = "0x5a9D124c05B425CD90613326577E03B3eBd1F891";
export declare const CHAIN_ID = 42161;
export declare const CHAIN_NAME = "Arbitrum One";
export declare const RPC_URL_DEFAULT = "https://arb1.arbitrum.io/rpc";
export declare const DEFAULT_DISPUTE_WINDOW = 86400;
export declare const DEFAULT_ARBITRATION_WINDOW = 259200;
export declare const ERC20_ABI: string[];
export declare const ESCROW_ABI: string[];
export declare const CHANNEL_ABI: string[];
export declare enum PactStatus {
    Active = 0,
    WorkSubmitted = 1,
    Approved = 2,
    Disputed = 3,
    Released = 4,
    Refunded = 5,
    ArbitrationRuled = 6
}
export declare enum ChannelState {
    Open = 0,
    Closing = 1,
    Closed = 2
}
//# sourceMappingURL=constants.d.ts.map