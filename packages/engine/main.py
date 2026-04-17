"""
AgentOS Neural Engine – entry point.

Run with:
    python main.py
or via Poetry script:
    poetry run engine
"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "engine.app:app",
        host="0.0.0.0",
        port=8765,
        reload=True,
        log_level="info",
    )
