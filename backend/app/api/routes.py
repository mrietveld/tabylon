import logging

from fastapi import APIRouter, HTTPException

from app.api.schemas import ErrorDetail, GroupingPlan, GroupingRequest


def create_router(grouping_service) -> APIRouter:
    logger = logging.getLogger("tab_organizer")
    router = APIRouter()

    @router.get("/health")
    def health_check():
        logger.info("Health check OK")
        return {
            "status":  "ok",
            "service": "tab-organizer-backend",
        }

    @router.post("/api/groupings/generate", response_model=GroupingPlan)
    def generate_grouping(request: GroupingRequest):
        logger.info("Grouping route called for request %s with %s tabs", request.requestId, len(request.tabs))
        try:
            return grouping_service.generate_grouping_plan(request)
        except ValueError as error:
            logger.warning("Grouping plan validation failed for %s: %s", request.requestId, error)
            raise HTTPException(
                    status_code=422,
                    detail=ErrorDetail(
                            code="PLAN_VALIDATION_FAILED",
                            message=str(error),
                    ).model_dump(),
            ) from error

    return router
