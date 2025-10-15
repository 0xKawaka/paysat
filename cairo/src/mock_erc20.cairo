use core::byte_array::ByteArray;
use core::integer::u256;
use starknet::contract_address::ContractAddress;

#[starknet::interface]
pub trait IERC20Metadata<TContractState> {
    fn name(self: @TContractState) -> ByteArray;
    fn symbol(self: @TContractState) -> ByteArray;
    fn decimals(self: @TContractState) -> u8;
    fn total_supply(self: @TContractState) -> u256;
    fn balance_of(self: @TContractState, account: ContractAddress) -> u256;
    fn allowance(self: @TContractState, owner: ContractAddress, spender: ContractAddress) -> u256;
    fn transfer(ref self: TContractState, to: ContractAddress, amount: u256) -> bool;
    fn approve(ref self: TContractState, spender: ContractAddress, amount: u256) -> bool;
    fn transfer_from(
        ref self: TContractState, from: ContractAddress, to: ContractAddress, amount: u256,
    ) -> bool;
    fn mint(ref self: TContractState, to: ContractAddress, amount: u256);
}

#[starknet::contract]
mod MockERC20 {
    use core::byte_array::ByteArray;
    use core::integer::u256;
    use core::num::traits::Zero;
    use starknet::contract_address::ContractAddress;
    use starknet::get_caller_address;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };

    #[storage]
    struct Storage {
        name: ByteArray,
        symbol: ByteArray,
        decimals: u8,
        owner: ContractAddress,
        total_supply: u256,
        balances: Map<ContractAddress, u256>,
        allowances: Map<(ContractAddress, ContractAddress), u256>,
    }

    #[derive(Drop, Serde, starknet::Event)]
    struct TransferEvent {
        #[key]
        from: ContractAddress,
        #[key]
        to: ContractAddress,
        value: u256,
    }

    #[derive(Drop, Serde, starknet::Event)]
    struct ApprovalEvent {
        #[key]
        owner: ContractAddress,
        #[key]
        spender: ContractAddress,
        value: u256,
    }

    #[event]
    #[derive(Drop, Serde, starknet::Event)]
    enum Event {
        Transfer: TransferEvent,
        Approval: ApprovalEvent,
    }

    #[constructor]
    fn constructor(
        ref self: ContractState,
        name: ByteArray,
        symbol: ByteArray,
        decimals: u8,
        initial_owner: ContractAddress,
        initial_supply: u256,
    ) {
        ensure_non_zero_address(initial_owner, 'ERC20_OWNER_ZERO');

        self.name.write(name);
        self.symbol.write(symbol);
        self.decimals.write(decimals);
        self.owner.write(initial_owner);
        self.total_supply.write(u256 { low: 0, high: 0 });

        if !is_zero_amount(initial_supply) {
            mint_unchecked(ref self, initial_owner, initial_supply);
        }
    }

    #[abi(embed_v0)]
    impl ERC20Impl of super::IERC20Metadata<ContractState> {
        fn name(self: @ContractState) -> ByteArray {
            self.name.read()
        }

        fn symbol(self: @ContractState) -> ByteArray {
            self.symbol.read()
        }

        fn decimals(self: @ContractState) -> u8 {
            self.decimals.read()
        }

        fn total_supply(self: @ContractState) -> u256 {
            self.total_supply.read()
        }

        fn balance_of(self: @ContractState, account: ContractAddress) -> u256 {
            self.balances.read(account)
        }

        fn allowance(
            self: @ContractState, owner: ContractAddress, spender: ContractAddress,
        ) -> u256 {
            self.allowances.read((owner, spender))
        }

        fn transfer(ref self: ContractState, to: ContractAddress, amount: u256) -> bool {
            ensure_non_zero_address(to, 'ERC20_TO_ZERO');
            let sender = get_caller_address();
            ensure_non_zero_address(sender, 'ERC20_FROM_ZERO');
            internal_transfer(ref self, sender, to, amount);
            true
        }

        fn approve(ref self: ContractState, spender: ContractAddress, amount: u256) -> bool {
            ensure_non_zero_address(spender, 'ERC20_SPENDER_ZERO');
            let owner = get_caller_address();
            ensure_non_zero_address(owner, 'ERC20_OWNER_ZERO');
            internal_approve(ref self, owner, spender, amount);
            true
        }

        fn transfer_from(
            ref self: ContractState, from: ContractAddress, to: ContractAddress, amount: u256,
        ) -> bool {
            ensure_non_zero_address(from, 'ERC20_FROM_ZERO');
            ensure_non_zero_address(to, 'ERC20_TO_ZERO');

            let spender = get_caller_address();
            let allowance = self.allowances.read((from, spender));
            assert(allowance >= amount, 'ERC20_NO_ALLOWANCE');
            self.allowances.write((from, spender), allowance - amount);

            internal_transfer(ref self, from, to, amount);
            true
        }

        fn mint(ref self: ContractState, to: ContractAddress, amount: u256) {
            require_owner(@self);
            ensure_non_zero_address(to, 'ERC20_TO_ZERO');
            mint_unchecked(ref self, to, amount);
        }
    }

    fn internal_transfer(
        ref self: ContractState, from: ContractAddress, to: ContractAddress, amount: u256,
    ) {
        if is_zero_amount(amount) {
            return;
        }

        let from_balance = self.balances.read(from);
        assert(from_balance >= amount, 'ERC20_NO_BALANCE');

        self.balances.write(from, from_balance - amount);
        let to_balance = self.balances.read(to);
        self.balances.write(to, to_balance + amount);

        Event::Transfer(TransferEvent { from, to, value: amount });
    }

    fn internal_approve(
        ref self: ContractState, owner: ContractAddress, spender: ContractAddress, amount: u256,
    ) {
        self.allowances.write((owner, spender), amount);
        Event::Approval(ApprovalEvent { owner, spender, value: amount });
    }

    fn mint_unchecked(ref self: ContractState, to: ContractAddress, amount: u256) {
        if is_zero_amount(amount) {
            return;
        }

        let supply = self.total_supply.read();
        self.total_supply.write(supply + amount);

        let balance = self.balances.read(to);
        self.balances.write(to, balance + amount);

        Event::Transfer(TransferEvent { from: Zero::zero(), to, value: amount });
    }

    fn require_owner(self: @ContractState) {
        assert(get_caller_address() == self.owner.read(), 'ERC20_NOT_OWNER');
    }

    fn ensure_non_zero_address(address: ContractAddress, message: felt252) {
        let value: felt252 = address.into();
        assert(value != 0, message);
    }

    fn is_zero_amount(amount: u256) -> bool {
        amount.low == 0 && amount.high == 0
    }
}
