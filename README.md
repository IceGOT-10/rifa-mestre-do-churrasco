# 🥩 Rifa Mestre do Churrasco • Sistema Web de Rifas Online

Sistema web de alta performance para rifas e sorteios online, construído em **Node.js (Express)** com **SQLite embutido (node:sqlite)**, controle transacional atômico de concorrência (`BEGIN IMMEDIATE`), bloqueio em duas etapas e exportação nativa em **Excel (.xlsx)**.

---

## 🚀 Principais Funcionalidades

### 👥 Visão do Usuário (Participante)
- **Grade Dinâmica de Números**: Seleção de 1 ou múltiplos números simultaneamente com barra flutuante de resumo em tempo real.
- **Bloqueio em Duas Etapas**:
  - **Etapa 1 (Pré-bloqueio)**: Reserva temporária de 10 minutos nos números selecionados enquanto preenche os dados (Nome e WhatsApp).
  - **Etapa 2 (Reserva & Pix)**: Confirmação atômica com tempo limite de 10 minutos para efetuar o pagamento Pix e enviar o comprovante no WhatsApp.
- **Identificação do Dispositivo**: Se o participante fechar a tela sem copiar o Pix ou atualizar a página, o sistema reconhece o dispositivo (`sessaoId`) e reabre a tela do Pix imediatamente ao clicar nos seus números reservados.
- **Tratamento de Concorrência**: Transação com `BEGIN IMMEDIATE` no SQLite. Em caso de disputa simultânea, o perdedor recebe status 409 com mensagem amigável e a grade é sincronizada instantaneamente.
- **Atualização em Tempo Real**: Polling curto (2s) com cabeçalhos anti-cache explícitos (`Cache-Control: no-cache, no-store, must-revalidate`).

### 🛠️ Painel Administrativo (`/admin`)
- **Autenticação Segura & Proteção contra Força Bruta**: Bloqueio de 5 minutos após 3 tentativas inválidas de login por IP.
- **Restrição de Rede Local**: Bloqueio contra proxies e túneis externos (ngrok/Cloudflare), garantindo operação local segura.
- **Gestão Completa de Rifas**:
  - Criar novas rifas definindo título, total de cotas (1 a 1000) e valor unitário.
  - Editar nome da rifa, quantidade de cotas e valor da cota da rifa ativa.
  - Encerrar e reabrir/destravar rifas (apenas 1 rifa aberta por vez na tela do público).
  - Excluir rifas com histórico arquivado.
- **Exportação Nativa em Excel (.xlsx)**:
  - Planilha profissional estilizada via `exceljs` com cabeçalho de identidade, tabela DRE com fórmulas (`SUM`, Lucro Líquido Real, Margem de Lucro %) e célula editável para inserção do custo do kit/prêmios.
  - Tabela detalhada de cotas com linhas zebradas e formatação condicional por status (`PAGO`, `PENDENTE`, `DISPONIVEL`).
- **Gerador de Mensagem para WhatsApp**: Formata a lista dos números confirmados ("Número - Nome", sem telefones por privacidade) com botão de cópia direta para a área de transferência.

---

## 🛠️ Tecnologias Utilizadas

- **Runtime**: Node.js >= 22.13 (com `node:sqlite` nativo)
- **Backend**: Express 4
- **Banco de Dados**: SQLite (modo WAL, transações atômicas `BEGIN IMMEDIATE`)
- **Planilhas**: `exceljs`
- **Frontend**: HTML5 Semântico, CSS3 Moderno (Responsivo), Vanilla JavaScript (Zero dependências externas)
- **Testes**: Node.js Test Runner / Assert (testes de concorrência com processos paralelos e testes de ciclo de vida/expiração)

---

## 📦 Como Instalar e Rodar

1. **Clone o repositório**:
   ```bash
   git clone https://github.com/IceGOT-10/rifa-mestre-do-churrasco.git
   cd rifa-mestre-do-churrasco
   ```

2. **Instale as dependências**:
   ```bash
   npm install
   ```

3. **Inicie o servidor**:
   ```bash
   npm start
   ```

4. **Acesse no navegador**:
   - **Página Pública da Rifa**: `http://localhost:3000`
   - **Painel Administrativo**: `http://localhost:3000/admin`
     - *Usuário padrão*: `admin`
     - *Senha padrão*: `churrasco123`

---

## 🧪 Testes Automatizados

O projeto conta com suíte completa de testes cobrindo concorrência massiva de reservas, expiração de timers, proteção contra força bruta, ciclo de vida de rifas e exportação Excel:

```bash
npm test
```

