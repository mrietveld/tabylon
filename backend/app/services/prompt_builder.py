from app.api.schemas import GroupingPlanGroup, GroupingRequest


def build_grouping_prompt(request: GroupingRequest, existing_groups: list[GroupingPlanGroup] | None = None) -> str:
    lines = [
        "Group the following browser tabs by shared theme or task.",
        f"Every group must contain at least {request.constraints.minimumGroupSize} tabs.",
        "Return strict JSON with planId, requestId, summary, groups, ungroupedTabIds, warnings.",
    ]

    if existing_groups:
        lines.append("Existing groups that may be preserved or extended:")
        for group in existing_groups:
            group_id = getattr(group, "groupId", group["groupId"])
            name = getattr(group, "name", group["name"])
            reason = getattr(group, "reason", group["reason"])
            tab_ids = getattr(group, "tabIds", group["tabIds"])
            lines.append(
                    f"- groupId={group_id} name={name!r} reason={reason!r} tabIds={tab_ids}"
            )

    lines.append("Tabs:")

    for tab in request.tabs:
        lines.append(f"- id={tab.tabId} title={tab.title!r} url={tab.url}")

    return "\n".join(lines)
