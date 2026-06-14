/// WorkflowRequest: the stateful shared object at the heart of the product.
/// Strict state machine; approvals and receipts are linked records.
/// The offchain agent can only call these entry points — every transition
/// is validated here, so policy can never be bypassed by the LLM.
module ops_agent::workflow {
    use std::string::String;
    use sui::coin::Coin;
    use sui::event;

    use ops_agent::org::{Org, can_approve, can_execute, is_member};
    use ops_agent::policy::{Self, PolicySet, BudgetBucket};

    // === States ===
    const STATE_SUBMITTED: u8 = 1;
    const STATE_PENDING_POLICY: u8 = 2;
    const STATE_PENDING_APPROVAL: u8 = 4;
    const STATE_APPROVED: u8 = 5;
    const STATE_EXECUTING: u8 = 7;
    const STATE_EXECUTED: u8 = 8;
    const STATE_FAILED: u8 = 9;
    const STATE_ESCALATED: u8 = 10;
    const STATE_CANCELLED: u8 = 11;
    const STATE_CLOSED: u8 = 12;

    // === Errors ===
    const EWrongState: u64 = 0;
    const ENotMember: u64 = 1;
    const ENotApprover: u64 = 2;
    const ENotExecutor: u64 = 3;
    const EWrongOrg: u64 = 4;
    const EPolicyBlocked: u64 = 5;
    const ENotEnoughApprovals: u64 = 6;
    const ESelfApproval: u64 = 7;
    const EDuplicateApproval: u64 = 8;
    const EWrongAmount: u64 = 9;
    const ENotRequester: u64 = 10;

    /// Shared object: one operational request and its full lifecycle.
    public struct WorkflowRequest has key {
        id: UID,
        org_id: ID,
        requester: address,
        title: String,
        category: String,
        amount: u64,
        vendor: address,
        description: String,
        state: u8,
        /// Result of onchain policy evaluation (required approvals).
        required_approvals: u8,
        approvals: vector<ApprovalRecord>,
        receipt: Option<ExecutionReceipt>,
        exception: Option<ExceptionRecord>,
    }

    public struct ApprovalRecord has store, copy, drop {
        approver: address,
        epoch: u64,
        note: String,
    }

    public struct ExecutionReceipt has store, copy, drop {
        executor: address,
        amount: u64,
        vendor: address,
        epoch: u64,
        /// sha256 of the agent's parsed intent + fired policy rules + plan +
        /// approvals: the receipt proves WHY the money moved, not just that it did.
        intent_hash: vector<u8>,
    }

    public struct ExceptionRecord has store, copy, drop {
        code: u64,
        detail: String,
        epoch: u64,
    }

    // === Events (the audit trail) ===
    public struct RequestSubmitted has copy, drop { request_id: ID, org_id: ID, requester: address, amount: u64, category: String }
    public struct PolicyEvaluated has copy, drop { request_id: ID, required_approvals: u8, blocked: bool }
    public struct RequestApproved has copy, drop { request_id: ID, approver: address, approvals_count: u64 }
    public struct RequestRejected has copy, drop { request_id: ID, approver: address, reason: String }
    public struct RequestExecuted has copy, drop { request_id: ID, executor: address, amount: u64, vendor: address }
    public struct RequestFailed has copy, drop { request_id: ID, detail: String }
    public struct RequestEscalated has copy, drop { request_id: ID }
    public struct RequestCancelled has copy, drop { request_id: ID }

    /// 1. Submit a request. Any org member may submit.
    public fun submit(
        org: &Org,
        title: String,
        category: String,
        amount: u64,
        vendor: address,
        description: String,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(is_member(org, sender), ENotMember);
        let req = WorkflowRequest {
            id: object::new(ctx),
            org_id: object::id(org),
            requester: sender,
            title,
            category,
            amount,
            vendor,
            description,
            state: STATE_SUBMITTED,
            required_approvals: 0,
            approvals: vector[],
            receipt: option::none(),
            exception: option::none(),
        };
        event::emit(RequestSubmitted {
            request_id: object::id(&req),
            org_id: req.org_id,
            requester: sender,
            amount,
            category: req.category,
        });
        transfer::share_object(req);
    }

    /// 2. Onchain policy check: Submitted -> PendingApproval | Approved | Escalated.
    public fun evaluate_policy(req: &mut WorkflowRequest, ps: &PolicySet, bucket: &BudgetBucket, ctx: &TxContext) {
        assert!(req.state == STATE_SUBMITTED || req.state == STATE_PENDING_POLICY, EWrongState);
        assert!(policy::policy_org_id(ps) == req.org_id, EWrongOrg);
        assert!(policy::bucket_org_id(bucket) == req.org_id, EWrongOrg);
        req.state = STATE_PENDING_POLICY;

        let needed = policy::required_approvals(ps, req.amount, req.vendor);
        let budget_ok = policy::has_headroom(bucket, req.amount);

        if (needed == 255 || !budget_ok) {
            req.state = STATE_ESCALATED;
            let detail = if (!budget_ok) {
                b"budget bucket has insufficient headroom".to_string()
            } else {
                b"blocked by policy: vendor rules or per-request cap".to_string()
            };
            req.exception = option::some(ExceptionRecord { code: EPolicyBlocked, detail, epoch: ctx.epoch() });
            event::emit(PolicyEvaluated { request_id: object::id(req), required_approvals: needed, blocked: true });
            event::emit(RequestEscalated { request_id: object::id(req) });
            return
        };

        req.required_approvals = needed;
        if (needed == 0) {
            req.state = STATE_APPROVED;
        } else {
            req.state = STATE_PENDING_APPROVAL;
        };
        event::emit(PolicyEvaluated { request_id: object::id(req), required_approvals: needed, blocked: false });
    }

    /// 3. Approve. Distinct approvers, no self-approval.
    public fun approve(req: &mut WorkflowRequest, org: &Org, note: String, ctx: &TxContext) {
        let sender = ctx.sender();
        assert!(req.state == STATE_PENDING_APPROVAL, EWrongState);
        assert!(object::id(org) == req.org_id, EWrongOrg);
        assert!(can_approve(org, sender), ENotApprover);
        assert!(sender != req.requester, ESelfApproval);

        let mut i = 0;
        while (i < req.approvals.length()) {
            assert!(req.approvals[i].approver != sender, EDuplicateApproval);
            i = i + 1;
        };

        req.approvals.push_back(ApprovalRecord { approver: sender, epoch: ctx.epoch(), note });
        event::emit(RequestApproved {
            request_id: object::id(req),
            approver: sender,
            approvals_count: req.approvals.length(),
        });

        if (req.approvals.length() >= (req.required_approvals as u64)) {
            req.state = STATE_APPROVED;
        }
    }

    /// 3b. Reject -> Escalated with exception record.
    public fun reject(req: &mut WorkflowRequest, org: &Org, reason: String, ctx: &TxContext) {
        let sender = ctx.sender();
        assert!(req.state == STATE_PENDING_APPROVAL, EWrongState);
        assert!(object::id(org) == req.org_id, EWrongOrg);
        assert!(can_approve(org, sender), ENotApprover);
        req.state = STATE_ESCALATED;
        req.exception = option::some(ExceptionRecord { code: ENotEnoughApprovals, detail: reason, epoch: ctx.epoch() });
        event::emit(RequestRejected { request_id: object::id(req), approver: sender, reason });
    }

    /// 4. Execute: pays the vendor from the provided coin, records spend
    /// against the budget bucket, emits a receipt. Atomic — if the budget
    /// check aborts, no payment happens.
    /// Generic over the payment asset (`Coin<T>`) so vendors can be paid in
    /// SUI, USDC, or any other coin type — the caller picks `T` via the
    /// transaction's type arguments.
    public fun execute<T>(
        req: &mut WorkflowRequest,
        org: &Org,
        bucket: &mut BudgetBucket,
        payment: Coin<T>,
        intent_hash: vector<u8>,
        ctx: &TxContext,
    ) {
        let sender = ctx.sender();
        assert!(req.state == STATE_APPROVED, EWrongState);
        assert!(object::id(org) == req.org_id, EWrongOrg);
        assert!(can_execute(org, sender), ENotExecutor);
        assert!(payment.value() == req.amount, EWrongAmount);

        req.state = STATE_EXECUTING;
        policy::record_spend(bucket, req.org_id, req.amount);
        transfer::public_transfer(payment, req.vendor);

        req.receipt = option::some(ExecutionReceipt {
            executor: sender,
            amount: req.amount,
            vendor: req.vendor,
            epoch: ctx.epoch(),
            intent_hash,
        });
        req.state = STATE_EXECUTED;
        event::emit(RequestExecuted {
            request_id: object::id(req),
            executor: sender,
            amount: req.amount,
            vendor: req.vendor,
        });
    }

    /// Mark failed (offchain executor reporting an unrecoverable error).
    public fun mark_failed(req: &mut WorkflowRequest, org: &Org, detail: String, ctx: &TxContext) {
        let sender = ctx.sender();
        assert!(req.state == STATE_APPROVED || req.state == STATE_EXECUTING, EWrongState);
        assert!(can_execute(org, sender), ENotExecutor);
        req.state = STATE_FAILED;
        req.exception = option::some(ExceptionRecord { code: 100, detail, epoch: ctx.epoch() });
        event::emit(RequestFailed { request_id: object::id(req), detail });
    }

    /// Failed -> Escalated (manual review) handled by approver/admin.
    public fun escalate(req: &mut WorkflowRequest, org: &Org, ctx: &TxContext) {
        assert!(req.state == STATE_FAILED, EWrongState);
        assert!(can_approve(org, ctx.sender()), ENotApprover);
        req.state = STATE_ESCALATED;
        event::emit(RequestEscalated { request_id: object::id(req) });
    }

    /// Requester or admin can cancel any non-terminal request.
    public fun cancel(req: &mut WorkflowRequest, org: &Org, ctx: &TxContext) {
        let sender = ctx.sender();
        assert!(
            req.state != STATE_EXECUTED && req.state != STATE_CLOSED && req.state != STATE_CANCELLED,
            EWrongState
        );
        assert!(sender == req.requester || can_approve(org, sender), ENotRequester);
        req.state = STATE_CANCELLED;
        event::emit(RequestCancelled { request_id: object::id(req) });
    }

    /// Executed -> Closed.
    public fun close(req: &mut WorkflowRequest, org: &Org, ctx: &TxContext) {
        assert!(req.state == STATE_EXECUTED, EWrongState);
        assert!(is_member(org, ctx.sender()), ENotMember);
        req.state = STATE_CLOSED;
    }

    // === Views ===
    public fun state(req: &WorkflowRequest): u8 { req.state }
    public fun amount(req: &WorkflowRequest): u64 { req.amount }
    public fun approvals_count(req: &WorkflowRequest): u64 { req.approvals.length() }
}
