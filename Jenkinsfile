
pipeline {
    agent {
        label 'windows && docker'
    }

    options {
        disableConcurrentBuilds()
        timeout(time: 10, unit: 'MINUTES')
    }

    stages {
        stage('Controleer Docker Desktop') {
            steps {
                powershell '''
                    Write-Host "HTF Leviathan - Windows Jenkins-agent"
                    docker version
                    if ($LASTEXITCODE -ne 0) {
                        throw "Docker Desktop is niet bereikbaar"
                    }
                '''
            }
        }
    }
}
