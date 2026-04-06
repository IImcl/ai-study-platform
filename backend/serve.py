import os

from waitress import serve

from app import app


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    threads = int(os.getenv("WAITRESS_THREADS", "4"))
    serve(app, host=host, port=port, threads=threads)
