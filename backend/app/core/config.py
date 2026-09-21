import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 5050
    log_dir: Path = Path("backend/logs")
    service_name: str = "tab-organizer-backend"
    llm_api_key: str | None = None
    llm_base_url: str = "https://api.openai.com/v1"
    embedding_model: str = "embedding-model"
    embedding_timeout_seconds: float = 30.0
    labeling_model: str = "labeling-model"
    labeling_timeout_seconds: float = 30.0
    embedding_db_path: Path = Path("backend/db/embed.sql3")
    cluster_label_db_path: Path = Path("backend/db/labels.sql3")


_DEFAULT_ENV_FILE = Path(__file__).resolve().parents[2] / ".env.local"


def load_local_env_file() -> dict[str, str]:
    env_file = Path(os.getenv("TAB_ORGANIZER_ENV_FILE", str(_DEFAULT_ENV_FILE)))
    if not env_file.exists():
        return {}

    return {
        key: value
        for key, value in dotenv_values(env_file).items()
        if value is not None
    }


def get_settings() -> Settings:
    file_values = load_local_env_file()

    def read_setting(name: str, default: str | None = None) -> str | None:
        return os.getenv(name, file_values.get(name, default))

    host = read_setting("TAB_ORGANIZER_HOST", "127.0.0.1")
    port = int(read_setting("TAB_ORGANIZER_PORT", "5050"))
    log_dir = Path(read_setting("TAB_ORGANIZER_LOG_DIR", "backend/logs"))
    llm_api_key = read_setting("TAB_ORGANIZER_LLM_API_KEY")
    llm_base_url = read_setting("TAB_ORGANIZER_LLM_BASE_URL", "https://api.openai.com/v1")

    embedding_model = read_setting("TAB_ORGANIZER_EMBEDDING_MODEL", "embedding-model")
    embedding_timeout_seconds = float(read_setting("TAB_ORGANIZER_EMBEDDING_TIMEOUT_SECONDS", "30"))

    labeling_model = read_setting("TAB_ORGANIZER_LABELING_MODEL", "labeling-model")
    labeling_timeout_seconds = float(read_setting("TAB_ORGANIZER_LABELING_TIMEOUT_SECONDS", "30"))

    embedding_db_path = Path(read_setting("TAB_ORGANIZER_EMBEDDING_DB_PATH", "backend/db/embed.sql3"))
    cluster_label_db_path = Path(read_setting("TAB_ORGANIZER_CLUSTER_LABEL_DB_PATH", "backend/db/cluster_labels.sql3"))

    return Settings(
            host=host,
            port=port,
            log_dir=log_dir,
            llm_api_key=llm_api_key,
            llm_base_url=llm_base_url,
            embedding_model=embedding_model,
            embedding_timeout_seconds=embedding_timeout_seconds,
            labeling_model=labeling_model,
            labeling_timeout_seconds=labeling_timeout_seconds,
            embedding_db_path=embedding_db_path,
            cluster_label_db_path=cluster_label_db_path,
    )
