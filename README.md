# Lojinha Web

Recriação web do projeto Java Swing encontrado em `lojinha.zip`.

Agora a aplicação roda com Node.js e SQLite.

URL local:

- http://localhost:3000

## Comandos

```bash
npm start
npm run check
```

Se o terminal ainda não reconhecer `node` ou `npm`, feche e abra o VS Code/terminal novamente. O Node foi instalado em `C:\Program Files\nodejs`.

## Login de demonstração

- Supervisor: `supervisor` / `supervisor123`
- Atendente: `atendente` / `atendente123`

## O que foi recriado

- Login com perfil de usuário e sessão em memória.
- Painel com métricas de produtos, estoque, vendas e faturamento.
- Cadastro, edição, exclusão e busca de produtos.
- Registro de vendas com carrinho, subtotal e baixa de estoque.
- Cadastro, edição e exclusão de usuários restrito ao perfil Supervisor.
- Permissões no backend: Atendente consulta produtos e registra vendas; Supervisor gerencia produtos, usuários e relatórios.
- Estoque mínimo por produto, alerta de estoque crítico e ajuste rápido de estoque.
- Histórico de vendas com filtros por período, operador e produto.
- Relatórios de faturamento, lucro estimado, descontos e produtos mais vendidos.
- Desconto por item e desconto no total da venda.
- Interface responsiva para desktop e celular.
- API Node.js servindo frontend e endpoints JSON.
- Banco SQLite estruturado em `data/lojinha.sqlite`.

## Banco SQLite

Tabelas criadas:

- `users`: usuários, login, cargo e senha com hash/salt.
- `products`: produtos, categoria, estoque, estoque mínimo, custo e preço em centavos.
- `sales`: cabeçalho da venda, operador, subtotal, desconto e total.
- `sale_items`: itens da venda com produto, quantidade, custo, desconto e valores.

O SQLite CLI também foi instalado. Em um terminal novo, use:

```bash
sqlite3 data/lojinha.sqlite ".tables"
```

## Extensões VS Code instaladas/recomendadas

- ESLint
- Prettier
- HTML CSS Support
- Auto Rename Tag
- SQLite Viewer

## Avaliação do projeto original

O ZIP contém um projeto NetBeans Java Swing com MySQL. As principais telas são:

- `Login.java`: autenticação.
- `Menu.java`: navegação por perfil.
- `Entrada.java`: cadastro e manutenção de produtos.
- `Venda.java`: consulta de produto, carrinho e registro de venda.
- `CadastroUsuario.java`: cadastro e manutenção de usuários.
- `BD Lojinha.sql`: tabelas `usuario`, `produto` e `venda`.

## Pontos de melhoria técnica

- Separar camadas de UI, regra de negócio e persistência. Hoje várias telas acessam o banco diretamente.
- Criar um serviço central de conexão com pool, em vez de repetir `DriverManager.getConnection`.
- Fechar `Connection`, `PreparedStatement` e `ResultSet` com `try-with-resources`.
- Corrigir query de usuário em `UsuarioDao`: usa `where usuario = ?`, mas a coluna é `Login`.
- Corrigir SQL de venda em `VendaDao`: `insert to venda` deveria ser `insert into venda`.
- Evitar tipos `double` e `float` para dinheiro. Usar decimal no banco e `BigDecimal` no backend.
- Criar relacionamento entre venda e itens de venda. A tabela atual grava venda por código de produto e não representa uma venda com múltiplos itens.
- Validar quantidade, valores, CPF, email e campos obrigatórios antes de gravar.
- Padronizar nomes de classes, métodos e colunas.
- Remover arquivos compilados (`build`, `dist`, `.class`, `.jar`) do repositório fonte.

## Pontos de segurança

- Credenciais do banco estão hardcoded no código: `root` e senha fixa.
- Senhas de usuários são gravadas em texto puro.
- Login não tem hash, salt, expiração de sessão ou política de bloqueio.
- Mensagens de erro podem expor detalhes internos do banco.
- Não existe controle de autorização no banco/API, apenas bloqueio visual no menu.
- Falta trilha de auditoria para alterações de produto, usuário e venda.
- Falta proteção contra manipulação de estoque negativo e duplicidade de login.

Para uma versão web em produção:

- Backend com autenticação via sessão segura ou JWT com expiração curta.
- Senhas com Argon2id ou bcrypt.
- Variáveis de ambiente para conexão com banco.
- API com autorização por perfil em cada endpoint.
- Validação server-side com mensagens amigáveis.
- HTTPS, CORS restrito e logs sem dados sensíveis.

## Pontos de design e UX

- O Swing usa layout absoluto, o que dificulta responsividade e manutenção.
- Algumas mensagens estão trocadas, por exemplo produto cadastrado exibindo texto de usuário.
- Falta feedback consistente para salvar, alterar, excluir e consultar.
- O fluxo de venda não deixa claro estoque disponível e pode falhar com conversões de tipo.
- A navegação abre muitas janelas. Na web, a experiência fica melhor com uma área única de trabalho.
- Melhorar contraste, espaçamento, estados de foco e uso de tabelas responsivas.

## Próximo passo recomendado

Transformar esta versão estática em uma aplicação completa:

- Frontend: React ou Vue.
- Backend: Node.js/Express, Java Spring Boot ou Laravel.
- Banco: MySQL ou PostgreSQL.
- Modelo de dados: `users`, `products`, `sales`, `sale_items`.
- Testes: validação de login, CRUD de produtos, baixa de estoque e autorização por perfil.
