FROM quay.io/lyfe00011/md:beta
RUN git clone https://github.com/lyfe00011/levanter.git /root/LyFE/
WORKDIR /root/LyFE/
RUN yarn install
COPY plugins/ /root/LyFE/plugins/
CMD ["npm", "start"]

