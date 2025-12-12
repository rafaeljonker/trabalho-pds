#!/bin/bash

# Cores para output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Iniciando projeto ===${NC}"

# Diretório do projeto
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

# Instalar dependências do backend
echo -e "${BLUE}Instalando dependências do backend...${NC}"
pip3 install -r backend/requirements.txt -q

# Iniciar backend em background
echo -e "${GREEN}Iniciando backend...${NC}"
cd backend
python3 audio_bridge.py &
BACKEND_PID=$!
cd ..

# Instalar dependências do frontend se necessário
if [ ! -d "node_modules" ]; then
    echo -e "${BLUE}Instalando dependências do frontend...${NC}"
    npm install
fi

# Iniciar frontend
echo -e "${GREEN}Iniciando frontend...${NC}"
npm run dev &
FRONTEND_PID=$!

echo -e "${GREEN}=== Projeto rodando ===${NC}"
echo -e "Backend PID: $BACKEND_PID"
echo -e "Frontend PID: $FRONTEND_PID"
echo -e "Pressione Ctrl+C para parar"

# Função para limpar ao sair
cleanup() {
    echo -e "\n${BLUE}Parando serviços...${NC}"
    kill $BACKEND_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Aguardar
wait
