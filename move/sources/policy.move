/// PolicySet + BudgetBucket: deterministic, onchain-enforced spending rules.
/// The agent proposes; these objects decide what is allowed.
module ops_agent::policy {
    use std::string::String;
    use sui::event;
    use sui::vec_set::{Self, VecSet};

    use ops_agent::org::{Org, AdminCap, org_id_of_cap};

    // === Errors ===
    const ENotAdmin: u64 = 0;
    const EWrongOrg: u64 = 1;
    const EBudgetExceeded: u64 = 2;

    /// Shared object: thresholds and rules for one org.
    /// Amounts are in MIST-equivalent base units (or stablecoin base units).
    public struct PolicySet has key {
        id: UID,
        org_id: ID,
        /// Requests at or below this amount auto-approve.
        auto_approve_max: u64,
        /// Requests above this amount need two approvals.
        dual_approval_min: u64,
        /// Hard cap per single request.
        per_request_cap: u64,
        /// Allowed vendor payout addresses. Empty = any allowed.
        vendor_allowlist: VecSet<address>,
        /// Explicitly denied vendors. Deny wins over allow.
        vendor_denylist: VecSet<address>,
    }

    /// Shared object: one budget category with a spend allowance.
    public struct BudgetBucket has key {
        id: UID,
        org_id: ID,
        name: String,
        limit: u64,
        spent: u64,
    }

    public struct PolicySetCreated has copy, drop { policy_id: ID, org_id: ID }
    public struct BudgetCreated has copy, drop { bucket_id: ID, org_id: ID, name: String, limit: u64 }
    public struct BudgetSpent has copy, drop { bucket_id: ID, amount: u64, remaining: u64 }

    public fun create_policy_set(
        org: &Org,
        cap: &AdminCap,
        auto_approve_max: u64,
        dual_approval_min: u64,
        per_request_cap: u64,
        ctx: &mut TxContext,
    ) {
        assert!(org_id_of_cap(cap) == object::id(org), ENotAdmin);
        let ps = PolicySet {
            id: object::new(ctx),
            org_id: object::id(org),
            auto_approve_max,
            dual_approval_min,
            per_request_cap,
            vendor_allowlist: vec_set::empty(),
            vendor_denylist: vec_set::empty(),
        };
        event::emit(PolicySetCreated { policy_id: object::id(&ps), org_id: ps.org_id });
        transfer::share_object(ps);
    }

    public fun create_budget_bucket(
        org: &Org,
        cap: &AdminCap,
        name: String,
        limit: u64,
        ctx: &mut TxContext,
    ) {
        assert!(org_id_of_cap(cap) == object::id(org), ENotAdmin);
        let b = BudgetBucket {
            id: object::new(ctx),
            org_id: object::id(org),
            name,
            limit,
            spent: 0,
        };
        event::emit(BudgetCreated { bucket_id: object::id(&b), org_id: b.org_id, name: b.name, limit });
        transfer::share_object(b);
    }

    public fun allow_vendor(ps: &mut PolicySet, cap: &AdminCap, vendor: address) {
        assert!(org_id_of_cap(cap) == ps.org_id, ENotAdmin);
        if (!ps.vendor_allowlist.contains(&vendor)) ps.vendor_allowlist.insert(vendor);
    }

    public fun deny_vendor(ps: &mut PolicySet, cap: &AdminCap, vendor: address) {
        assert!(org_id_of_cap(cap) == ps.org_id, ENotAdmin);
        if (!ps.vendor_denylist.contains(&vendor)) ps.vendor_denylist.insert(vendor);
    }

    // === Deterministic evaluation (used by workflow module) ===

    /// 0 = auto-approve, 1 = one approver, 2 = two approvers, 255 = blocked
    public fun required_approvals(ps: &PolicySet, amount: u64, vendor: address): u8 {
        if (amount > ps.per_request_cap) return 255;
        if (ps.vendor_denylist.contains(&vendor)) return 255;
        if (!ps.vendor_allowlist.is_empty() && !ps.vendor_allowlist.contains(&vendor)) return 255;
        if (amount <= ps.auto_approve_max) return 0;
        if (amount >= ps.dual_approval_min) return 2;
        1
    }

    /// Reserve spend from a bucket; aborts if over budget.
    public fun record_spend(bucket: &mut BudgetBucket, org_id: ID, amount: u64) {
        assert!(bucket.org_id == org_id, EWrongOrg);
        assert!(bucket.spent + amount <= bucket.limit, EBudgetExceeded);
        bucket.spent = bucket.spent + amount;
        event::emit(BudgetSpent {
            bucket_id: object::id(bucket),
            amount,
            remaining: bucket.limit - bucket.spent,
        });
    }

    public fun has_headroom(bucket: &BudgetBucket, amount: u64): bool {
        bucket.spent + amount <= bucket.limit
    }

    public fun policy_org_id(ps: &PolicySet): ID { ps.org_id }
    public fun bucket_org_id(b: &BudgetBucket): ID { b.org_id }
    public fun bucket_remaining(b: &BudgetBucket): u64 { b.limit - b.spent }
}
