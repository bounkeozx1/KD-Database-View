FROM node:22-alpine
WORKDIR /app
COPY . .
RUN mkdir -p data/db data/uploads/employee-photos data/uploads/passports data/uploads/id-cards data/uploads/documents
EXPOSE 3000
CMD ["node", "--no-warnings", "shell/server.js"]
