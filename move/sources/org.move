/// Organization identity, membership, and roles.
module ops_agent::org {
    use std::string::String;
    use sui::event;
    use sui::table::{Self, Table};

    // === Roles ===
    const ROLE_REQUESTER: u8 = 0;
    const ROLE_APPROVER: u8 = 1;
    const ROLE_FINANCE_ADMIN: u8 = 2;
    const ROLE_EXECUTOR: u8 = 3;

    // === Errors ===
    const ENotAdmin: u64 = 0;
    const EInvalidRole: u64 = 2;

    /// Shared object: the organization. All workflows, policies, and
    /// budgets reference an Org by ID — composability via object links.
    public struct Org has key {
        id: UID,
        name: String,
        admin: address,
        /// wallet -> role
        members: Table<address, u8>,
    }

    /// Capability proving admin rights over an Org.
    public struct AdminCap has key, store {
        id: UID,
        org_id: ID,
    }

    public struct OrgCreated has copy, drop {
        org_id: ID,
        name: String,
        admin: address,
    }

    public struct MemberAdded has copy, drop {
        org_id: ID,
        member: address,
        role: u8,
    }

    /// Create a new shared Org; sender becomes admin and receives AdminCap.
    public fun create_org(name: String, ctx: &mut TxContext): AdminCap {
        let sender = ctx.sender();
        let mut org = Org {
            id: object::new(ctx),
            name,
            admin: sender,
            members: table::new(ctx),
        };
        org.members.add(sender, ROLE_FINANCE_ADMIN);
        let org_id = object::id(&org);
        event::emit(OrgCreated { org_id, name: org.name, admin: sender });
        transfer::share_object(org);
        AdminCap { id: object::new(ctx), org_id }
    }

    entry fun create_org_entry(name: String, ctx: &mut TxContext) {
        let cap = create_org(name, ctx);
        transfer::public_transfer(cap, ctx.sender());
    }

    /// Admin assigns or updates a member role.
    public fun set_member_role(
        org: &mut Org,
        cap: &AdminCap,
        member: address,
        role: u8,
    ) {
        assert!(cap.org_id == object::id(org), ENotAdmin);
        assert!(role <= ROLE_EXECUTOR, EInvalidRole);
        if (org.members.contains(member)) {
            *org.members.borrow_mut(member) = role;
        } else {
            org.members.add(member, role);
        };
        event::emit(MemberAdded { org_id: object::id(org), member, role });
    }

    // === Views / role checks used by other modules ===

    public fun role_of(org: &Org, who: address): u8 {
        assert!(org.members.contains(who), EInvalidRole);
        *org.members.borrow(who)
    }

    public fun is_member(org: &Org, who: address): bool {
        org.members.contains(who)
    }

    public fun can_approve(org: &Org, who: address): bool {
        if (!org.members.contains(who)) return false;
        let r = *org.members.borrow(who);
        r == ROLE_APPROVER || r == ROLE_FINANCE_ADMIN
    }

    public fun can_execute(org: &Org, who: address): bool {
        if (!org.members.contains(who)) return false;
        let r = *org.members.borrow(who);
        r == ROLE_EXECUTOR || r == ROLE_FINANCE_ADMIN
    }

    public fun org_id_of_cap(cap: &AdminCap): ID { cap.org_id }

    public fun role_requester(): u8 { ROLE_REQUESTER }
    public fun role_approver(): u8 { ROLE_APPROVER }
    public fun role_finance_admin(): u8 { ROLE_FINANCE_ADMIN }
    public fun role_executor(): u8 { ROLE_EXECUTOR }
}
