import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import create_router
from app.core.config import get_settings
from app.core.logging_setup import configure_logging
from app.services.cluster_label_store import ClusterLabelStore
from app.services.clusterer import Clusterer
from app.services.embedding_client import EmbeddingClient, EmbeddingClientError
from app.services.embedding_store import EmbeddingStore
from app.services.grouping_service import GroupingService
from app.services.labeling_client import LabelingClient, LabelingClientError


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_dir)
    logger = logging.getLogger("tab_organizer")

    app = FastAPI(title=settings.service_name)
    app.state.settings = settings
    app.state.logger = logger
    app.add_middleware(
            CORSMiddleware,
            allow_origin_regex=r"moz-extension://.*",
            allow_credentials=False,
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["*"],
    )

    embedding_client = EmbeddingClient(
            api_key=settings.llm_api_key or "",
            model=settings.embedding_model,
            base_url=settings.llm_base_url,
            timeout_seconds=settings.embedding_timeout_seconds,
    )
    embedding_store = EmbeddingStore(settings.embedding_db_path)
    cluster_label_store = ClusterLabelStore(settings.cluster_label_db_path)
    clusterer = Clusterer(min_cluster_size=5)
    labeling_client = LabelingClient(
            api_key=settings.llm_api_key or "",
            model=settings.labeling_model,
            base_url=settings.llm_base_url,
            timeout_seconds=settings.labeling_timeout_seconds,
    )

    app.state.grouping_service = GroupingService(
            embedding_client=embedding_client,
            labeling_client=labeling_client,
            embedding_store=embedding_store,
            cluster_label_store=cluster_label_store,
            clusterer=clusterer,
    )
    app.include_router(create_router(app.state.grouping_service))

    @app.exception_handler(EmbeddingClientError)
    async def embedding_client_error_handler(request: Request, error: EmbeddingClientError):
        logger.exception("Embedding client error during %s %s", request.method, request.url.path)
        return JSONResponse(
                status_code=502,
                content={
                    "detail": {
                        "code":    "EMBEDDING_REQUEST_FAILED",
                        "message": str(error),
                    }
                },
        )

    @app.exception_handler(LabelingClientError)
    async def labeling_client_error_handler(request: Request, error: LabelingClientError):
        logger.exception("Labeling client error during %s %s", request.method, request.url.path)
        return JSONResponse(
                status_code=502,
                content={
                    "detail": {
                        "code":    "CLUSTER_LABELING_FAILED",
                        "message": str(error),
                    }
                },
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, error: Exception):
        logger.exception("Unhandled backend error during %s %s", request.method, request.url.path)
        return JSONResponse(
                status_code=500,
                content={
                    "detail": {
                        "code":    "INTERNAL_ERROR",
                        "message": "The backend hit an unexpected error.",
                    }
                },
        )

    return app


app = create_app()
