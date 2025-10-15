use cairo::escrow_vault::{EscrowPhase, IEscrowVaultDispatcher, IEscrowVaultDispatcherTrait};
use cairo::mock_erc20::{IERC20MetadataDispatcher, IERC20MetadataDispatcherTrait};
use core::array::ArrayTrait;
use core::byte_array::ByteArray;
use core::integer::u256;
use core::serde::Serde;
use core::option::OptionTrait;
use core::sha256::compute_sha256_byte_array;
use core::traits::{Into, TryInto};
use snforge_std::{
    ContractClassTrait, DeclareResultTrait, declare, start_cheat_block_timestamp_global,
    start_cheat_caller_address, stop_cheat_block_timestamp_global, stop_cheat_caller_address,
};
use starknet::contract_address::ContractAddress;

const OWNER_FELT: felt252 = 0x101;
const PROTOCOL_OPERATOR_FELT: felt252 = 0x202;
const PROTOCOL_TREASURY_FELT: felt252 = 0x303;
const TOKEN_OWNER_FELT: felt252 = 0x404;
const USER_FELT: felt252 = 0x505;
const EXPIRY_WINDOW: u64 = 3600; // 1 hour
const INITIAL_SUPPLY: u256 = u256 { low: 1_000_000, high: 0 };
const PAYMENT_AMOUNT: u256 = u256 { low: 5_000, high: 0 };
const PAYMENT_LIMIT: u256 = u256 { low: 10_000, high: 0 };

#[test]
fn test_payment_claim_flow() {
    let (token_address, escrow_address) = setup_protocol();
    let user_address = user();
    let operator_address = protocol_operator();
    let treasury_address = protocol_treasury();

    seed_user_balance(token_address, escrow_address, user_address, PAYMENT_AMOUNT);

    let preimage: ByteArray = "ln-secret";
    let hash = compute_sha_hash(@preimage);

    let base_timestamp: u64 = 1_000;
    start_cheat_block_timestamp_global(base_timestamp);
    start_cheat_caller_address(escrow_address, user_address);
    let escrow = IEscrowVaultDispatcher { contract_address: escrow_address };
    escrow.lock_for_ln_payment(user_address, PAYMENT_AMOUNT, hash);
    stop_cheat_caller_address(escrow_address);
    stop_cheat_block_timestamp_global();

    let token = IERC20MetadataDispatcher { contract_address: token_address };
    assert(
        token.balance_of(user_address) == u256 { low: 0, high: 0 },
        'user balance not debited',
    );
    assert(token.balance_of(escrow_address) == PAYMENT_AMOUNT, 'escrow did not receive funds');

    let position = escrow.get_escrow(hash);
    assert(position.phase == EscrowPhase::Locked, 'unexpected phase after lock');
    assert(position.expires_at == base_timestamp + EXPIRY_WINDOW, 'wrong expiry recorded');

    start_cheat_caller_address(escrow_address, operator_address);
    escrow.claim(hash, preimage);
    stop_cheat_caller_address(escrow_address);

    assert(escrow.get_escrow(hash).phase == EscrowPhase::Claimed, 'expected claimed phase');
    assert(
        token.balance_of(treasury_address) == PAYMENT_AMOUNT,
        'treasury did not receive funds',
    );
    assert(token.balance_of(escrow_address) == u256 { low: 0, high: 0 }, 'escrow should be empty');
}

#[test]
fn test_payment_refund_flow() {
    let (token_address, escrow_address) = setup_protocol();
    let user_address = user();

    seed_user_balance(token_address, escrow_address, user_address, PAYMENT_AMOUNT);

    let preimage: ByteArray = "refund-secret";
    let hash = compute_sha_hash(@preimage);

    let base_timestamp: u64 = 5_000;
    start_cheat_block_timestamp_global(base_timestamp);
    start_cheat_caller_address(escrow_address, user_address);
    let escrow = IEscrowVaultDispatcher { contract_address: escrow_address };
    escrow.lock_for_ln_payment(user_address, PAYMENT_AMOUNT, hash);
    stop_cheat_caller_address(escrow_address);

    stop_cheat_block_timestamp_global();

    let expected_expiry = base_timestamp + EXPIRY_WINDOW;

    start_cheat_block_timestamp_global(expected_expiry + 1);
    start_cheat_caller_address(escrow_address, user_address);
    escrow.refund(hash);
    stop_cheat_caller_address(escrow_address);
    stop_cheat_block_timestamp_global();

    let token = IERC20MetadataDispatcher { contract_address: token_address };
    assert(token.balance_of(user_address) == PAYMENT_AMOUNT, 'user should be refunded');
    assert(token.balance_of(escrow_address) == u256 { low: 0, high: 0 }, 'escrow should be empty');

    let position = escrow.get_escrow(hash);
    assert(position.phase == EscrowPhase::Refunded, 'expected refunded phase');
    assert(position.expires_at == expected_expiry, 'expiry should remain unchanged');
}

#[test]
fn test_operator_refund_before_expiry() {
    let (token_address, escrow_address) = setup_protocol();
    let user_address = user();
    let operator_address = protocol_operator();

    seed_user_balance(token_address, escrow_address, user_address, PAYMENT_AMOUNT);

    let preimage: ByteArray = "operator-refund";
    let hash = compute_sha_hash(@preimage);

    let base_timestamp: u64 = 12_000;
    start_cheat_block_timestamp_global(base_timestamp);
    start_cheat_caller_address(escrow_address, user_address);
    let escrow = IEscrowVaultDispatcher { contract_address: escrow_address };
    escrow.lock_for_ln_payment(user_address, PAYMENT_AMOUNT, hash);
    stop_cheat_caller_address(escrow_address);
    stop_cheat_block_timestamp_global();

    start_cheat_caller_address(escrow_address, operator_address);
    escrow.operator_refund(hash);
    stop_cheat_caller_address(escrow_address);

    let token = IERC20MetadataDispatcher { contract_address: token_address };
    assert(
        token.balance_of(user_address) == PAYMENT_AMOUNT,
        'operator refund missing',
    );
    assert(
        token.balance_of(escrow_address) == u256 { low: 0, high: 0 },
        'escrow not empty post op',
    );
    assert(
        escrow.get_escrow(hash).phase == EscrowPhase::Refunded,
        'op refund phase mismatch',
    );
}

#[test]
fn test_get_config_returns_payment_limit() {
    let (_, escrow_address) = setup_protocol();
    let escrow = IEscrowVaultDispatcher { contract_address: escrow_address };
    let config = escrow.get_config();
    assert(config.payment_limit == PAYMENT_LIMIT, 'payment limit mismatch');
}

fn setup_protocol() -> (ContractAddress, ContractAddress) {
    setup_protocol_with_limit(PAYMENT_LIMIT)
}

fn setup_protocol_with_limit(payment_limit: u256) -> (ContractAddress, ContractAddress) {
    let token_address = deploy_mock_token(token_owner(), INITIAL_SUPPLY);
    let escrow_address = deploy_escrow(token_address, EXPIRY_WINDOW, payment_limit);

    (token_address, escrow_address)
}

fn seed_user_balance(
    token_address: ContractAddress,
    escrow_address: ContractAddress,
    user: ContractAddress,
    amount: u256,
) {
    let token = IERC20MetadataDispatcher { contract_address: token_address };

    start_cheat_caller_address(token_address, token_owner());
    assert(token.transfer(user, amount), 'owner transfer failed');
    stop_cheat_caller_address(token_address);

    start_cheat_caller_address(token_address, user);
    assert(token.approve(escrow_address, amount), 'user approve failed');
    stop_cheat_caller_address(token_address);

    assert(token.balance_of(user) == amount, 'user funding failed');
}

fn deploy_mock_token(owner: ContractAddress, initial_supply: u256) -> ContractAddress {
    let contract = declare("MockERC20").unwrap().contract_class();
    let mut calldata = ArrayTrait::new();
    let name: ByteArray = "MockERC20";
    let symbol: ByteArray = "MK";
    let decimals: u8 = 18;
    name.serialize(ref calldata);
    symbol.serialize(ref calldata);
    decimals.serialize(ref calldata);
    owner.serialize(ref calldata);
    initial_supply.serialize(ref calldata);
    let (address, _) = contract.deploy(@calldata).unwrap();
    address
}

fn deploy_escrow(asset: ContractAddress, expiry_window: u64, payment_limit: u256) -> ContractAddress {
    let contract = declare("EscrowVault").unwrap().contract_class();
    let mut calldata = ArrayTrait::new();
    let owner_address = owner();
    let operator_address = protocol_operator();
    let treasury_address = protocol_treasury();
    owner_address.serialize(ref calldata);
    operator_address.serialize(ref calldata);
    treasury_address.serialize(ref calldata);
    let asset_address = asset;
    asset_address.serialize(ref calldata);
    let expiry = expiry_window;
    expiry.serialize(ref calldata);
    payment_limit.serialize(ref calldata);
    let (address, _) = contract.deploy(@calldata).unwrap();
    address
}

fn compute_sha_hash(preimage: @ByteArray) -> u256 {
    let words = compute_sha256_byte_array(preimage);
    words_to_u256(words)
}

fn words_to_u256(words: [u32; 8]) -> u256 {
    let [w0, w1, w2, w3, w4, w5, w6, w7] = words;
    u256 {
        high: words_to_u128(w0, w1, w2, w3),
        low: words_to_u128(w4, w5, w6, w7),
    }
}

fn words_to_u128(w0: u32, w1: u32, w2: u32, w3: u32) -> u128 {
    const WORD_BASE: felt252 = 0x100000000;
    let mut acc: felt252 = 0;
    acc = acc * WORD_BASE + w0.into();
    acc = acc * WORD_BASE + w1.into();
    acc = acc * WORD_BASE + w2.into();
    acc = acc * WORD_BASE + w3.into();
    acc.try_into().unwrap()
}

fn owner() -> ContractAddress {
    felt_to_contract_address(OWNER_FELT, 'OWNER_INVALID')
}

fn protocol_operator() -> ContractAddress {
    felt_to_contract_address(PROTOCOL_OPERATOR_FELT, 'OPERATOR_INVALID')
}

fn protocol_treasury() -> ContractAddress {
    felt_to_contract_address(PROTOCOL_TREASURY_FELT, 'TREASURY_INVALID')
}

fn token_owner() -> ContractAddress {
    felt_to_contract_address(TOKEN_OWNER_FELT, 'TOKEN_OWNER_INVALID')
}

fn user() -> ContractAddress {
    felt_to_contract_address(USER_FELT, 'USER_INVALID')
}

fn felt_to_contract_address(value: felt252, error: felt252) -> ContractAddress {
    value.try_into().expect(error)
}
