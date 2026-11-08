# Shrink, but do not rename: a readable stack trace is worth more than the
# few hundred kilobytes renaming would save.
-dontobfuscate

# sshj (direct route). eddsa refers to a JDK-internal class it only uses
# on a desktop JVM; sshj finds some algorithms by name at run time.
-dontwarn sun.security.x509.X509Key
-dontwarn org.slf4j.impl.**
# Kerberos login (GSS-API), which Android does not have and Burrow never uses.
-dontwarn org.ietf.jgss.**
-dontwarn javax.security.auth.login.**
-keep class net.schmizz.sshj.** { *; }
-keep class com.hierynomus.sshj.** { *; }
