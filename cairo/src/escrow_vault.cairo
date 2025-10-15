use core::byte_array::ByteArray;
use core::integer::u256;
use starknet::contract_address::ContractAddress;

const MAX_EXPIRY_WINDOW: u64 = 604800; // seven days

#[derive(Copy, Drop, Serde, PartialEq, Default, starknet::Store)]
pub enum EscrowPhase {
    #[default]
    None,
    Locked,
    Claimed,
    Refunded,
}

#[derive(Copy, Drop, Serde, starknet::Store)]
pub struct EscrowPosition {
    pub phase: EscrowPhase,
    pub user: ContractAddress,
    pub amount: u256,
    pub expires_at: u64,
    pub locked_at: u64,
}

#[derive(Copy, Drop, Serde)]
pub struct VaultConfig {
    pub owner: ContractAddress,
    pub protocol_operator: ContractAddress,
    pub protocol_treasury: ContractAddress,
    pub asset: ContractAddress,
    pub expiry_window: u64,
    pub payment_limit: u256,
}

#[starknet::interface]
pub trait IERC20<TContractState> {
    fn transfer_from(
        ref self: TContractState, sender: ContractAddress, recipient: ContractAddress, amount: u256,
    ) -> bool;
    fn transfer(ref self: TContractState, recipient: ContractAddress, amount: u256) -> bool;
}

#[starknet::interface]
pub trait IEscrowVault<TContractState> {
    fn lock_for_ln_payment(
        ref self: TContractState, user: ContractAddress, amount: u256, hash: u256,
    );
    fn claim(ref self: TContractState, hash: u256, preimage: ByteArray);
    fn refund(ref self: TContractState, hash: u256);
    fn operator_refund(ref self: TContractState, hash: u256);
    fn get_escrow(self: @TContractState, hash: u256) -> EscrowPosition;
    fn get_config(self: @TContractState) -> VaultConfig;
    fn transfer_ownership(ref self: TContractState, new_owner: ContractAddress);
    fn update_protocol_operator(ref self: TContractState, new_operator: ContractAddress);
    fn update_protocol_treasury(ref self: TContractState, new_treasury: ContractAddress);
    fn update_asset(ref self: TContractState, new_asset: ContractAddress);
    fn update_expiry_window(ref self: TContractState, new_expiry_window: u64);
}

#[starknet::contract]
mod EscrowVault {
    use core::byte_array::ByteArray;
    use core::integer::u256;
    use core::num::traits::Zero;
    use core::option::OptionTrait;
    use core::panic_with_felt252;
    use core::sha256::compute_sha256_byte_array;
    use core::traits::{Into, TryInto};
    use starknet::contract_address::ContractAddress;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::{get_block_timestamp, get_caller_address, get_contract_address};
    use super::{
        EscrowPhase, EscrowPosition, IERC20Dispatcher, IERC20DispatcherTrait, MAX_EXPIRY_WINDOW,
        VaultConfig,
    };

    #[storage]
    struct Storage {
        owner: ContractAddress,
        protocol_operator: ContractAddress,
        protocol_treasury: ContractAddress,
        asset: ContractAddress,
        expiry_window: u64,
        payment_limit: u256,
        hashlocks: Map<u256, EscrowPosition>,
    }

    impl EscrowPositionDefault of Default<EscrowPosition> {
        fn default() -> EscrowPosition {
            EscrowPosition {
                phase: EscrowPhase::None,
                user: Zero::zero(),
                amount: u256 { low: 0, high: 0 },
                expires_at: 0,
                locked_at: 0,
            }
        }
    }

    #[derive(Drop, Serde, starknet::Event)]
    struct LockedEvent {
        #[key]
        user: ContractAddress,
        amount: u256,
        #[key]
        hash: u256,
        expires_at: u64,
        locked_at: u64,
    }

    #[derive(Drop, Serde, starknet::Event)]
    struct ClaimedEvent {
        user: ContractAddress,
        #[key]
        hash: u256,
        amount: u256,
        preimage: ByteArray,
        claimer: ContractAddress,
    }

    #[derive(Drop, Serde, starknet::Event)]
    struct RefundedEvent {
        #[key]
        hash: u256,
        user: ContractAddress,
        amount: u256,
        refunded_at: u64,
    }

    #[event]
    #[derive(Drop, Serde, starknet::Event)]
    enum Event {
        Locked: LockedEvent,
        Claimed: ClaimedEvent,
        Refunded: RefundedEvent,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        owner: ContractAddress,
        protocol_operator: ContractAddress,
        protocol_treasury: ContractAddress,
        asset: ContractAddress,
        expiry_window: u64,
        payment_limit: u256,
    ) {
        ensure_non_zero(owner, 'OWNER_ZERO');
        ensure_non_zero(protocol_operator, 'OPERATOR_ZERO');
        ensure_non_zero(protocol_treasury, 'TREASURY_ZERO');
        ensure_non_zero(asset, 'ASSET_ZERO');
        validate_expiry_window(expiry_window);
        ensure_non_zero_limit(payment_limit);

        self.owner.write(owner);
        self.protocol_operator.write(protocol_operator);
        self.protocol_treasury.write(protocol_treasury);
        self.asset.write(asset);
        self.expiry_window.write(expiry_window);
        self.payment_limit.write(payment_limit);
    }

    #[abi(embed_v0)]
    impl EscrowVaultImpl of super::IEscrowVault<ContractState> {
        fn lock_for_ln_payment(
            ref self: ContractState, user: ContractAddress, amount: u256, hash: u256,
        ) {
            ensure_non_zero(user, 'USER_ZERO');
            require_caller(user, 'NOT_USER');

            let now = get_block_timestamp();
            let window = self.expiry_window.read();
            let expires_at = now + window;
            assert_non_zero_amount(amount);
            let payment_limit = self.payment_limit.read();
            ensure_amount_within_limit(amount, payment_limit);

            let existing = self.hashlocks.read(hash);
            assert(existing.phase == EscrowPhase::None, 'HASH_REUSED');

            let asset = self.asset.read();
            let mut token = IERC20Dispatcher { contract_address: asset };
            let escrow_address = get_contract_address();
            assert(token.transfer_from(user, escrow_address, amount), 'TRANSFER_FROM_FAIL');

            let escrow = EscrowPosition {
                phase: EscrowPhase::Locked, user, amount, expires_at, locked_at: now,
            };
            self.hashlocks.write(hash, escrow);

            Event::Locked(LockedEvent { user, amount, hash, expires_at, locked_at: now });
        }

        fn claim(ref self: ContractState, hash: u256, preimage: ByteArray) {
            require_caller(self.protocol_operator.read(), 'NOT_OPERATOR');

            let mut escrow = self.hashlocks.read(hash);
            assert(escrow.phase == EscrowPhase::Locked, 'NOT_LOCKED');

            let computed = sha256_digest(@preimage);
            assert(computed == hash, 'HASH_MISMATCH');

            let amount = escrow.amount;
            let user = escrow.user;
            let treasury = self.protocol_treasury.read();

            let asset = self.asset.read();
            let mut token = IERC20Dispatcher { contract_address: asset };
            assert(token.transfer(treasury, amount), 'TRANSFER_FAIL');

            escrow.phase = EscrowPhase::Claimed;
            self.hashlocks.write(hash, escrow);

            Event::Claimed(
                ClaimedEvent { user, hash, amount, preimage, claimer: get_caller_address() },
            );
        }

        fn refund(ref self: ContractState, hash: u256) {
            let mut escrow = self.hashlocks.read(hash);
            assert(escrow.phase == EscrowPhase::Locked, 'NOT_LOCKED');

            let now = get_block_timestamp();
            assert(now >= escrow.expires_at, 'ESCROW_ACTIVE');

            let amount = escrow.amount;
            let user = escrow.user;

            let asset = self.asset.read();
            let mut token = IERC20Dispatcher { contract_address: asset };
            assert(token.transfer(user, amount), 'TRANSFER_FAIL');

            escrow.phase = EscrowPhase::Refunded;
            self.hashlocks.write(hash, escrow);

            Event::Refunded(RefundedEvent { hash, user, amount, refunded_at: now });
        }

        fn operator_refund(ref self: ContractState, hash: u256) {
            require_caller(self.protocol_operator.read(), 'NOT_OPERATOR');

            let mut escrow = self.hashlocks.read(hash);
            assert(escrow.phase == EscrowPhase::Locked, 'NOT_LOCKED');

            let amount = escrow.amount;
            let user = escrow.user;
            let now = get_block_timestamp();

            let asset = self.asset.read();
            let mut token = IERC20Dispatcher { contract_address: asset };
            assert(token.transfer(user, amount), 'TRANSFER_FAIL');

            escrow.phase = EscrowPhase::Refunded;
            self.hashlocks.write(hash, escrow);

            Event::Refunded(RefundedEvent { hash, user, amount, refunded_at: now });
        }

        fn get_escrow(self: @ContractState, hash: u256) -> EscrowPosition {
            self.hashlocks.read(hash)
        }

        fn get_config(self: @ContractState) -> VaultConfig {
            VaultConfig {
                owner: self.owner.read(),
                protocol_operator: self.protocol_operator.read(),
                protocol_treasury: self.protocol_treasury.read(),
                asset: self.asset.read(),
                expiry_window: self.expiry_window.read(),
                payment_limit: self.payment_limit.read(),
            }
        }

        fn transfer_ownership(ref self: ContractState, new_owner: ContractAddress) {
            ensure_non_zero(new_owner, 'OWNER_ZERO');
            require_caller(self.owner.read(), 'NOT_OWNER');
            self.owner.write(new_owner);
        }

        fn update_protocol_operator(ref self: ContractState, new_operator: ContractAddress) {
            ensure_non_zero(new_operator, 'OPERATOR_ZERO');
            require_caller(self.owner.read(), 'NOT_OWNER');
            self.protocol_operator.write(new_operator);
        }

        fn update_protocol_treasury(ref self: ContractState, new_treasury: ContractAddress) {
            ensure_non_zero(new_treasury, 'TREASURY_ZERO');
            require_caller(self.owner.read(), 'NOT_OWNER');
            self.protocol_treasury.write(new_treasury);
        }

        fn update_asset(ref self: ContractState, new_asset: ContractAddress) {
            ensure_non_zero(new_asset, 'ASSET_ZERO');
            require_caller(self.owner.read(), 'NOT_OWNER');
            self.asset.write(new_asset);
        }

        fn update_expiry_window(ref self: ContractState, new_expiry_window: u64) {
            validate_expiry_window(new_expiry_window);
            require_caller(self.owner.read(), 'NOT_OWNER');
            self.expiry_window.write(new_expiry_window);
        }
    }

    fn require_caller(expected: ContractAddress, error: felt252) {
        assert(get_caller_address() == expected, error);
    }

    fn validate_expiry_window(window: u64) {
        assert(window < MAX_EXPIRY_WINDOW, 'EXPIRY_GT_WEEK');
    }

    fn ensure_non_zero(address: ContractAddress, error: felt252) {
        let value: felt252 = address.into();
        assert(value != 0, error);
    }

    fn ensure_non_zero_limit(limit: u256) {
        if limit.low == 0 && limit.high == 0 {
            panic_with_felt252('LIMIT_ZERO');
        }
    }

    fn ensure_amount_within_limit(amount: u256, limit: u256) {
        if amount.high > limit.high {
            panic_with_felt252('LIMIT_EXCEEDED');
        }
        if amount.high == limit.high && amount.low > limit.low {
            panic_with_felt252('LIMIT_EXCEEDED');
        }
    }

    fn assert_non_zero_amount(amount: u256) {
        if amount.low == 0 && amount.high == 0 {
            panic_with_felt252('AMOUNT_ZERO');
        }
    }

    fn sha256_digest(preimage: @ByteArray) -> u256 {
        let digest_words = compute_sha256_byte_array(preimage);
        words_to_u256(digest_words)
    }

    fn words_to_u256(words: [u32; 8]) -> u256 {
        let [w0, w1, w2, w3, w4, w5, w6, w7] = words;
        let high = words_to_u128(w0, w1, w2, w3);
        let low = words_to_u128(w4, w5, w6, w7);
        u256 { low, high }
    }

    fn words_to_u128(w0: u32, w1: u32, w2: u32, w3: u32) -> u128 {
        const WORD_BASE: felt252 = 0x100000000;
        let mut acc: felt252 = 0;
        acc = acc * WORD_BASE + w0.into();
        acc = acc * WORD_BASE + w1.into();
        acc = acc * WORD_BASE + w2.into();
        acc = acc * WORD_BASE + w3.into();
        acc.try_into().expect('LIMB_OVERFLOW')
    }
}
