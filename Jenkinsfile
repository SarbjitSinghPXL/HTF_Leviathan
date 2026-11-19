
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
        stage('Controleer GHCR login') {
            steps {
                withCredentials([
                    usernamePassword(
                        credentialsId: 'github-ghcr',
                        usernameVariable: 'GHCR_USER',
                        passwordVariable: 'GHCR_TOKEN'
                    )
                ]) {
                    powershell '''
                        $ErrorActionPreference = "Stop"

                        # Tijdelijke Docker-loginconfiguratie
                        $env:DOCKER_CONFIG = Join-Path $env:TEMP ("jenkins-ghcr-" + $env:BUILD_NUMBER)
                        New-Item -ItemType Directory -Force -Path $env:DOCKER_CONFIG | Out-Null

                        try {
                            $env:GHCR_TOKEN | docker login ghcr.io `
                                --username $env:GHCR_USER `
                                --password-stdin

                            if ($LASTEXITCODE -ne 0) {
                                throw "GHCR login mislukt"
                            }

                            Write-Host "GHCR login geslaagd!"
                        }
                        finally {
                            Remove-Item $env:DOCKER_CONFIG -Recurse -Force -ErrorAction SilentlyContinue
                        }
                    '''
                }
            }
        }
    }
}
