"""Tests for backend grouping-plan validation rules.

The validator is the safety barrier between model output and browser-side tab
changes, so these tests document the rules the backend must enforce.
"""

import pytest

from app.api.schemas import GroupingPlan, GroupingPlanGroup, GroupingRequest, GroupingConstraints, BrowserTab
from app.services.validator import validate_grouping_plan


def make_request(tab_ids):
    """Build a compact grouping request fixture from a list of tab IDs.

    Keeping this helper in the test file makes each test read more like a
    business rule and less like schema construction boilerplate.
    """
    return GroupingRequest(
        requestId="req-1",
        capturedAt="2026-07-16T10:00:00Z",
        constraints=GroupingConstraints(minimumGroupSize=5),
        tabs=[
            BrowserTab(
                tabId=tab_id,
                windowId=1,
                title=f"Tab {tab_id}",
                url=f"https://example.com/{tab_id}",
                active=False,
                pinned=False,
                audible=False,
                discarded=False,
            )
            for tab_id in tab_ids
        ],
    )


def test_validate_grouping_plan_rejects_unknown_tab_ids():
    """A plan cannot reference tabs that were not present in the request."""
    request = make_request([1, 2, 3, 4, 5])
    plan = GroupingPlan(
        planId="plan-1",
        requestId="req-1",
        summary="Summary",
        groups=[
            GroupingPlanGroup(
                groupId="group-1",
                name="Known tabs",
                reason="A reason",
                tabIds=[1, 2, 3, 4, 999],
            )
        ],
        ungroupedTabIds=[],
        warnings=[],
    )

    with pytest.raises(ValueError, match="unknown tab IDs"):
        validate_grouping_plan(plan, request)


def test_validate_grouping_plan_rejects_duplicate_tab_assignment():
    """A tab may belong to at most one proposed group in a plan."""
    request = make_request([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    plan = GroupingPlan(
        planId="plan-1",
        requestId="req-1",
        summary="Summary",
        groups=[
            GroupingPlanGroup(
                groupId="group-1",
                name="Group one",
                reason="A reason",
                tabIds=[1, 2, 3, 4, 5],
            ),
            GroupingPlanGroup(
                groupId="group-2",
                name="Group two",
                reason="Another reason",
                tabIds=[5, 6, 7, 8, 9],
            ),
        ],
        ungroupedTabIds=[10],
        warnings=[],
    )

    with pytest.raises(ValueError, match="assigned more than once"):
        validate_grouping_plan(plan, request)


def test_validate_grouping_plan_rejects_groups_under_minimum_size():
    """Every accepted group must satisfy the minimum size constraint."""
    request = make_request([1, 2, 3, 4, 5])
    plan = GroupingPlan(
        planId="plan-1",
        requestId="req-1",
        summary="Summary",
        groups=[
            GroupingPlanGroup(
                groupId="group-1",
                name="Too small",
                reason="A reason",
                tabIds=[1, 2, 3, 4],
            )
        ],
        ungroupedTabIds=[5],
        warnings=[],
    )

    with pytest.raises(ValueError, match="at least 5 tabs"):
        validate_grouping_plan(plan, request)


def test_validate_grouping_plan_accepts_valid_plan():
    """A valid plan should be returned unchanged for downstream use."""
    request = make_request([1, 2, 3, 4, 5, 6])
    plan = GroupingPlan(
        planId="plan-1",
        requestId="req-1",
        summary="Summary",
        groups=[
            GroupingPlanGroup(
                groupId="group-1",
                name="Valid group",
                reason="A reason",
                tabIds=[1, 2, 3, 4, 5],
            )
        ],
        ungroupedTabIds=[6],
        warnings=["One tab left ungrouped."],
    )

    validated = validate_grouping_plan(plan, request)

    assert validated == plan
