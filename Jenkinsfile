
pipeline {
    agent {
        label 'windows && docker'
    }

    options {
        disableConcurrentBuilds()
        timeout(time: 20, unit: 'MINUTES')
    }

    stages {
        stage('Build frontend image') {
            steps {
                powershell '''
                    docker build `
                      --platform linux/amd64 `
                      -f frontend/Dockerfile `
                      -t htf-leviathan-frontend:test `
                      ./frontend

                    if ($LASTEXITCODE -ne 0) {
                        throw "Frontend Docker build mislukt"
                    }

                    docker image inspect htf-leviathan-frontend:test `
                      --format "{{.Os}}/{{.Architecture}}"

                    if ($LASTEXITCODE -ne 0) {
                        throw "Docker image inspect mislukt"
                    }
                '''
            }
        }
        stage('Build API image') {
            steps {
                powershell '''
                    docker build `
                    --platform linux/amd64 `
                    -f api/Dockerfile `
                    -t htf-leviathan-api:test `
                    ./api

                    if ($LASTEXITCODE -ne 0) {
                        throw "API Docker build mislukt"
                    }

                    docker image inspect htf-leviathan-api:test `
                    --format "{{.Os}}/{{.Architecture}}"

                    if ($LASTEXITCODE -ne 0) {
                        throw "Docker image inspect mislukt"
                    }
                '''
            }
        }
    }
}
