from typing import List

from pydantic import BaseModel, Field


class GroupingConstraints(BaseModel):
    minimumGroupSize: int = Field(default=5, ge=1)
    groupingBasis: str = "common theme or task"


class BrowserTab(BaseModel):
    tabId: int
    windowId: int
    title: str
    url: str
    active: bool
    pinned: bool
    audible: bool
    discarded: bool


class GroupingRequest(BaseModel):
    requestId: str
    capturedAt: str
    constraints: GroupingConstraints = Field(default_factory=GroupingConstraints)
    tabs: List[BrowserTab]


class GroupingPlanGroup(BaseModel):
    groupId: str
    name: str
    reason: str
    tabIds: List[int]


class GroupingPlan(BaseModel):
    planId: str
    requestId: str
    summary: str
    groups: List[GroupingPlanGroup]
    ungroupedTabIds: List[int]
    warnings: List[str]


class ErrorDetail(BaseModel):
    code: str
    message: str
