from app.api.schemas import GroupingPlan, GroupingRequest


def validate_grouping_plan(plan: GroupingPlan, request: GroupingRequest) -> GroupingPlan:
    request_tab_ids = {tab.tabId for tab in request.tabs}
    assigned_tab_ids = []

    for group in plan.groups:
        if len(group.tabIds) < request.constraints.minimumGroupSize:
            raise ValueError(
                    f"Each group must contain at least {request.constraints.minimumGroupSize} tabs"
            )

        if not group.name.strip() or not group.reason.strip():
            raise ValueError("Each group must contain a non-empty name and reason")

        unknown_tab_ids = set(group.tabIds) - request_tab_ids
        if unknown_tab_ids:
            raise ValueError(f"Grouping plan contains unknown tab IDs: {sorted(unknown_tab_ids)}")

        assigned_tab_ids.extend(group.tabIds)

    duplicates = sorted({tab_id for tab_id in assigned_tab_ids if assigned_tab_ids.count(tab_id) > 1})
    if duplicates:
        raise ValueError(f"Tabs cannot be assigned more than once: {duplicates}")

    unknown_ungrouped = set(plan.ungroupedTabIds) - request_tab_ids
    if unknown_ungrouped:
        raise ValueError(f"Ungrouped list contains unknown tab IDs: {sorted(unknown_ungrouped)}")

    return plan
