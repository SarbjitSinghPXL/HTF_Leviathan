// DB_HOST defaults to the Docker Compose service name; Kubernetes sets DB_HOST=mariadb.
// DB_USER / DB_PASSWORD / DB_NAME take precedence; the MYSQL_* names are kept for
// compatibility with the existing db.env used by Docker Compose.
export const dbConfig = {
    host: process.env.DB_HOST || "db-htf",
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || process.env.MYSQL_USER,
    password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD,
    database: process.env.DB_NAME || process.env.MYSQL_DATABASE,
    connectTimeout: 10_000,
}
