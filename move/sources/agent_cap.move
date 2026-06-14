/// AgentCap: the AI agent's spending authority as a first-class onchain object.
///
/// The agent holds a capability with hard, admin-tunable bounds:
///   - max amount per autonomous execution
///   - rolling per-epoch spend limit
///   - instant revocation
///
/// The agent can only call `execute_autonomous` while every bound holds.
/// Its autonomy is not a backend config flag — it is a policy-bound,
/// revocable Sui object, auditable and composable like everything else.
module ops_agent::agent_cap {
    use std::string::String;
    use sui::coin::Coin;
    use sui::event;

    use ops_agent::org::{Org, AdminCap, org_id_of_cap};
    use ops_agent::policy::{Self, BudgetBucket};
    use ops_agent::workflow::{Self, WorkflowRequest};

    // === Errors ===
    const ENotAdmin: u64 = 0;
    const ERevoked: u64 = 1;
    const EOverPerRequest: u64 = 2;
    const EOverEpochLimit: u64 = 3;
    const EWrongOrg: u64 = 4;
    const ENotAutoApproved: u64 = 5;

    /// Owned by the agent's keypair; bounds enforced on every call.
    public struct AgentCap has key, store {
        id: UID,
        org_id: ID,
        label: String,
        max_per_request: u64,
        epoch_limit: u64,
        spent_this_epoch: u64,
        epoch: u64,
        revoked: bool,
    }

    public struct AgentCapIssued has copy, drop { cap_id: ID, org_id: ID, max_per_request: u64, epoch_limit: u64 }
    public struct AgentCapUpdated has copy, drop { cap_id: ID, max_per_request: u64, epoch_limit: u64, revoked: bool }
    public struct AutonomousExecution has copy, drop { cap_id: ID, request_id: ID, amount: u64, spent_this_epoch: u64 }

    /// Admin issues a capability to the agent's address.
    public fun issue(
        org: &Org,
        admin: &AdminCap,
        agent_address: address,
        label: String,
        max_per_request: u64,
        epoch_limit: u64,
        ctx: &mut TxContext,
    ) {
        assert!(org_id_of_cap(admin) == object::id(org), ENotAdmin);
        let cap = AgentCap {
            id: object::new(ctx),
            org_id: object::id(org),
            label,
            max_per_request,
            epoch_limit,
            spent_this_epoch: 0,
            epoch: ctx.epoch(),
            revoked: false,
        };
        event::emit(AgentCapIssued {
            cap_id: object::id(&cap), org_id: cap.org_id,
            max_per_request, epoch_limit,
        });
        transfer::public_transfer(cap, agent_address);
    }

    /// Admin tunes or revokes the agent's authority at any time.
    /// (Cap is owned by the agent, so tuning goes through a shared-friendly
    /// pattern in production; for the MVP the admin holds a reference path
    /// via transfer-back or the cap is held in a shared wrapper.)
    public fun set_bounds(
        cap: &mut AgentCap,
        admin: &AdminCap,
        max_per_request: u64,
        epoch_limit: u64,
        revoked: bool,
    ) {
        assert!(org_id_of_cap(admin) == cap.org_id, ENotAdmin);
        cap.max_per_request = max_per_request;
        cap.epoch_limit = epoch_limit;
        cap.revoked = revoked;
        event::emit(AgentCapUpdated { cap_id: object::id(cap), max_per_request, epoch_limit, revoked });
    }

    /// The agent's only path to moving money without a human:
    /// request must already be auto-Approved by policy (state 5 with zero
    /// required approvals), and every AgentCap bound must hold. The epoch
    /// window resets automatically.
    /// Generic over the payment asset (`Coin<T>`) — mirrors
    /// `workflow::execute`, so the agent can pay vendors in SUI, USDC, or
    /// any other coin type.
    public fun execute_autonomous<T>(
        cap: &mut AgentCap,
        req: &mut WorkflowRequest,
        org: &Org,
        bucket: &mut BudgetBucket,
        payment: Coin<T>,
        intent_hash: vector<u8>,
        ctx: &TxContext,
    ) {
        assert!(!cap.revoked, ERevoked);
        assert!(cap.org_id == object::id(org), EWrongOrg);
        assert!(policy::bucket_org_id(bucket) == cap.org_id, EWrongOrg);

        // Reset the rolling window on epoch change.
        if (ctx.epoch() > cap.epoch) {
            cap.epoch = ctx.epoch();
            cap.spent_this_epoch = 0;
        };

        let amount = workflow::amount(req);
        assert!(amount <= cap.max_per_request, EOverPerRequest);
        assert!(cap.spent_this_epoch + amount <= cap.epoch_limit, EOverEpochLimit);
        // Must be auto-approved (Approved with zero human approvals).
        assert!(workflow::state(req) == 5 && workflow::approvals_count(req) == 0, ENotAutoApproved);

        cap.spent_this_epoch = cap.spent_this_epoch + amount;

        // Delegate to the standard execution path — budget debit, payment,
        // receipt, and state transition happen atomically in this PTB.
        // Note: the agent's address must hold ROLE_EXECUTOR in the Org.
        workflow::execute<T>(req, org, bucket, payment, intent_hash, ctx);

        event::emit(AutonomousExecution {
            cap_id: object::id(cap),
            request_id: object::id(req),
            amount,
            spent_this_epoch: cap.spent_this_epoch,
        });
    }
}
