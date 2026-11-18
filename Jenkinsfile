
pipeline {
    agent {
        kubernetes {
            yaml '''
apiVersion: v1
kind: Pod
spec:
  containers:
    - name: git
      image: alpine/git:2.47.2
      command:
        - cat
      tty: true
      resources:
        requests:
          cpu: 50m
          memory: 64Mi
        limits:
          cpu: 250m
          memory: 256Mi
'''
            defaultContainer 'git'
        }
    }

    options {
        disableConcurrentBuilds()
        timeout(time: 10, unit: 'MINUTES')
    }

    stages {
        stage('Controleer repository') {
            steps {
                sh '''
                    echo "HTF Leviathan - Jenkins test"
                    git --version
                    git log -1 --oneline
                    echo "Repository succesvol opgehaald!"
                '''
            }
        }
    }
}
