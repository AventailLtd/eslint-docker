# Eslint + stylelint for docker pipeline

    docker build -t dblaci/frontend-linter:20221017 .
    docker login
    docker push dblaci/frontend-linter:20221017

Tesztelni:

docker run --rm -it -w /var/www/html -v /var/www/html/:/var/www/html sha256:asdasdasdasd bash -c "NODE_PATH=/node_modules /node_modules/eslint/bin/eslint.js 'src*/**/*.{js,vue}' 'vue/**/*.{js,vue}' --ignore-path .eslintignore.prod --max-warnings 0"
docker run --rm -it -w /var/www/html -v /tmp:/var/www/html/node_modules -v /var/www/html/:/var/www/html dblaci/frontend-linter:20221017 bash -c "/node_modules/stylelint/bin/stylelint.js 'src*/**/*.{scss,vue}' --ignore-path .eslintignore.prod"
