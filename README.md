# 🧬 Nexamiro AI: The Open Autonomous Architecture

Nexamiro is an enterprise-grade, open-source AI platform designed to orchestrate multi-agent swarms, integrate with private enterprise data (RAG), and route complex reasoning tasks dynamically across open-weight models. 

Built as a direct, self-hosted alternative to proprietary ecosystems like Anthropic, Nexamiro guarantees data privacy, air-gapped compliance, and infinite extensibility.

## 🏗 Core Architecture
* **User Interface:** React (Vite) + Tailwind CSS (Dark Enterprise Theme)
* **Agent Orchestration:** Multi-Agent Swarm (Planner, Reasoning, Coding) via Model Context Protocol (MCP)
* **Knowledge Retrieval:** Native Vector DB integrations for secure RAG pipelines
* **Model Routing:** Dynamic switching between DeepSeek, Llama, and specialized models based on token constraints and task complexity.

## 🚀 Quick Start (Local Development)

1. **Clone the repository:**
   ```bash
   git clone https://github.com/bionanite/nexamiro.git
   cd nexamiro
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Start the development server:**
   ```bash
   npm run dev
   ```

## 🛡 Production Deployment
Nexamiro is designed for secure, containerized deployment using Docker. See the `docker-compose.yml` for the full stack configuration including the frontend, API gateway, and vector database.
